import { useState, useEffect, useRef } from "react";
import { Play, Plus, Settings, X, Globe, ChevronRight, Loader2, CheckCircle2, Pause, Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import OpenAI from "openai";
import { Anthropic } from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { get, set, entries, del } from "idb-keyval";
import "./App.css";

type TranslationProvider = "openai" | "anthropic" | "gemini";
type AudioProvider = "openai" | "gemini";

interface Paragraph {
  id: string;
  originalText: string;
  translatedText: string | null;
  isLoading: boolean;
  isAudioLoading: boolean;
  isPlaying: boolean;
  isPaused?: boolean;
  isCached?: boolean;
}

interface Session {
  id: string;
  url: string;
  title: string;
  paragraphs: Paragraph[];
  iframeContent: string;
  isFetching: boolean;
  scrollPosition?: number;
  iframeScrollPosition?: number;
}

const getCacheKey = (text: string, lang: string) => {
  return lang === "Japanese" ? `trans_${text}` : `trans_${lang}_${text}`;
};

const setCacheRecord = async (key: string, data: any) => {
  try { await set(key, { data, timestamp: Date.now() }); } catch(e){}
};

const getCacheRecord = async (key: string) => {
  try {
    const res: any = await get(key);
    if (res && typeof res === 'object' && res.timestamp) {
       return res.data;
    }
  } catch(e) {}
  return null;
}

const purgeOldCaches = async () => {
  try {
    const allEntries = await entries();
    const now = Date.now();
    const expiry = 180 * 24 * 60 * 60 * 1000;
    
    const cacheEntries = allEntries.filter(([k]) => k.toString().startsWith("trans_") || k.toString().startsWith("audio_"));
    
    const toDelete = cacheEntries.filter(([, v]: [any, any]) => {
      if (!v || !v.timestamp) return true;
      return now - v.timestamp > expiry;
    });

    for (const [k] of toDelete) {
        await del(k);
    }
    
    const remaining = cacheEntries.filter(([, v]: [any, any]) => v && v.timestamp && (now - v.timestamp <= expiry));
    if (remaining.length > 10000) {
      remaining.sort((a: any, b: any) => a[1].timestamp - b[1].timestamp);
      const limitDelete = remaining.slice(0, remaining.length - 10000);
      for (const [k] of limitDelete) {
         await del(k);
      }
    }
  } catch(e) {
    console.error("Failed to purge caches", e);
  }
};

const ObserverWrapper = ({ index, isAutoTranslate, onIntersect, children }: { index: number, isAutoTranslate: boolean, onIntersect: (index: number) => void, children: React.ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  const onIntersectRef = useRef(onIntersect);
  useEffect(() => { onIntersectRef.current = onIntersect; }, [onIntersect]);

  useEffect(() => {
    if (!isAutoTranslate) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        onIntersectRef.current(index);
      }
    }, { rootMargin: '0px 0px 50% 0px', threshold: 0 });
    
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [index, isAutoTranslate]);
  
  return <div ref={ref}>{children}</div>;
};

function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRefs = useRef<{ [key: string]: HTMLAudioElement }>({});

  const [translationProvider, setTranslationProvider] = useState<TranslationProvider>("openai");
  const [audioProvider, setAudioProvider] = useState<AudioProvider>("openai");
  
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({ openai: "", anthropic: "", gemini: "" });
  const [aiModels, setAiModels] = useState<Record<string, string>>({ openai: "", anthropic: "claude-3-7-sonnet-latest", gemini: "gemini-2.5-pro" });
  const [audioVoices, setAudioVoices] = useState<Record<string, string>>({ openai: "alloy", gemini: "Kore" });

  const [targetLanguage, setTargetLanguage] = useState("Japanese");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [tempTranslationProvider, setTempTranslationProvider] = useState<TranslationProvider>("openai");
  const [tempAudioProvider, setTempAudioProvider] = useState<AudioProvider>("openai");
  const [tempApiKeys, setTempApiKeys] = useState<Record<string, string>>({ openai: "", anthropic: "", gemini: "" });
  const [tempAiModels, setTempAiModels] = useState<Record<string, string>>({ openai: "", anthropic: "claude-3-7-sonnet-latest", gemini: "gemini-2.5-pro" });
  const [tempAudioVoices, setTempAudioVoices] = useState<Record<string, string>>({ openai: "alloy", gemini: "Kore" });

  const [tempLanguage, setTempLanguage] = useState("Japanese");
  const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({ openai: [], anthropic: [], gemini: [] });
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [cacheSizeMb, setCacheSizeMb] = useState<number | null>(null);
  const [isAutoTranslate, setIsAutoTranslate] = useState(false);
  const [tempAutoTranslate, setTempAutoTranslate] = useState(false);

  const [sessions, setSessions] = useState<Session[]>([{
    id: "default", url: "", title: "", paragraphs: [], iframeContent: "", isFetching: false,
  }]);
  const [activeSessionId, setActiveSessionId] = useState<string>("default");
  const [activeParagraphId, setActiveParagraphId] = useState<string | null>(null);

  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"top" | "bottom" | null>(null);

  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const savedTransProvider = localStorage.getItem("bilin_translation_provider") as TranslationProvider;
    if (savedTransProvider) { setTranslationProvider(savedTransProvider); setTempTranslationProvider(savedTransProvider); }
    
    const savedAudioProvider = localStorage.getItem("bilin_audio_provider") as AudioProvider;
    if (savedAudioProvider) { setAudioProvider(savedAudioProvider); setTempAudioProvider(savedAudioProvider); }

    const savedKeys = localStorage.getItem("bilin_api_keys");
    if (savedKeys) {
       const parsed = JSON.parse(savedKeys);
       setApiKeys(prev => ({...prev, ...parsed}));
       setTempApiKeys(prev => ({...prev, ...parsed}));
    } else {
       const oldKey = localStorage.getItem("open_ai_api_key");
       if (oldKey) {
           setApiKeys(prev => ({ ...prev, openai: oldKey }));
           setTempApiKeys(prev => ({ ...prev, openai: oldKey }));
       }
    }

    const savedModels = localStorage.getItem("bilin_ai_models");
    if (savedModels) {
       const parsed = JSON.parse(savedModels);
       setAiModels(prev => ({...prev, ...parsed}));
       setTempAiModels(prev => ({...prev, ...parsed}));
    } else {
       const oldModel = localStorage.getItem("bilin_ai_model");
       if (oldModel) {
           setAiModels(prev => ({ ...prev, openai: oldModel }));
           setTempAiModels(prev => ({ ...prev, openai: oldModel }));
       }
    }

    const savedVoices = localStorage.getItem("bilin_audio_voices");
    if (savedVoices) {
       const parsed = JSON.parse(savedVoices);
       setAudioVoices(prev => ({...prev, ...parsed}));
       setTempAudioVoices(prev => ({...prev, ...parsed}));
    }

    const lang = localStorage.getItem("bilin_target_language");
    if (lang) {
      setTargetLanguage(lang);
      setTempLanguage(lang);
    }

    const autoTransSetting = localStorage.getItem("bilin_auto_translate");
    if (autoTransSetting === "true") {
      setIsAutoTranslate(true);
      setTempAutoTranslate(true);
    }

    const cachedModels = localStorage.getItem("bilin_available_models");
    if (cachedModels) {
      try {
        const parsed = JSON.parse(cachedModels);
        if (Array.isArray(parsed)) {
           // Migration from old array
           setAvailableModels(prev => ({ ...prev, openai: parsed }));
        } else {
           setAvailableModels(prev => ({ ...prev, ...parsed }));
        }
      } catch (e) {}
    }

    get("bilin_sessions").then((saved) => {
      if (saved && Array.isArray(saved) && saved.length > 0) {
        const resetSaved = saved.map(s => ({
            ...s,
            isFetching: false,
            // 過去の iframeUrl を消すための互換対応
            iframeContent: s.iframeContent || s.iframeUrl || "",
            paragraphs: s.paragraphs.map((p: any) => ({
                ...p, isLoading: false, isAudioLoading: false, isPlaying: false, isPaused: false 
            }))
        }));
        setSessions(resetSaved);
        setActiveSessionId(resetSaved[0].id);
      }
      setIsLoaded(true);
    });

    const timer = setTimeout(() => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => purgeOldCaches());
      } else {
        purgeOldCaches();
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (isSettingsOpen) {
      calculateCacheSize();
    }
  }, [isSettingsOpen]);

  const fetchModels = async (keyToUse?: string | React.MouseEvent) => {
    const provider = tempTranslationProvider;
    const key = typeof keyToUse === "string" ? keyToUse : (tempApiKeys[provider] || apiKeys[provider]);
    if (!key) return;
    setIsFetchingModels(true);
    try {
      let chatModels: string[] = [];
      if (provider === "openai") {
        const openai = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
        const response = await openai.models.list();
        chatModels = response.data.map(m => m.id).filter(id => id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3")).sort();
      } else if (provider === "anthropic") {
        const anthropic = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, defaultHeaders: { "anthropic-dangerously-allow-browser": "true" } });
        const response = await anthropic.models.list();
        chatModels = response.data.map(m => m.id).filter(id => id.includes("claude")).sort();
      } else if (provider === "gemini") {
        const genAI = new GoogleGenAI({ apiKey: key });
        // The sdk allows fetching models through list() for generative models
        const response = await genAI.models.list();
        for await (const m of response) {
           if (m.name && m.name.includes("gemini")) {
               chatModels.push(m.name);
           }
        }
        chatModels.sort();
      }
      
      if (chatModels.length > 0) {
        setAvailableModels(prev => {
           const updated = { ...prev, [provider]: chatModels };
           localStorage.setItem("bilin_available_models", JSON.stringify(updated));
           return updated;
        });
        if (!tempAiModels[provider] && chatModels.length > 0) {
           setTempAiModels(prev => ({ ...prev, [provider]: chatModels[0] }));
        }
      }
    } catch (e) {
      console.warn("Failed to fetch models", e);
    } finally {
      setIsFetchingModels(false);
    }
  };

  useEffect(() => {
    if (apiKeys.openai && (!availableModels.openai || availableModels.openai.length === 0) && !isFetchingModels && tempTranslationProvider === "openai") {
      fetchModels(apiKeys.openai);
    }
  }, [apiKeys.openai, availableModels.openai?.length, tempTranslationProvider]);

  const calculateCacheSize = async () => {
    setCacheSizeMb(null);
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.usage !== undefined) {
          setCacheSizeMb(Math.round((estimate.usage / 1024 / 1024) * 100) / 100);
          return;
        }
      }
      const all = await entries();
      let totalBytes = 0;
      all.forEach(([k, v]: any) => {
        if (k.toString().startsWith("trans_") || k.toString().startsWith("audio_")) {
          if (v && v.data instanceof Blob) {
             totalBytes += v.data.size;
          } else if (v && typeof v.data === "string") {
             totalBytes += v.data.length * 2;
          }
        }
      });
      setCacheSizeMb(Math.round((totalBytes / 1024 / 1024) * 100) / 100);
    } catch(e) {
      setCacheSizeMb(0);
    }
  };

  const clearAllCaches = async () => {
    if (!window.confirm("すべての翻訳と音声のキャッシュをリセットしますか？(APIキーやタブは保持されます)")) return;
    try {
      const all = await entries();
      for (const [k] of all) {
        if (k.toString().startsWith("trans_") || k.toString().startsWith("audio_")) {
          await del(k);
        }
      }
      setCacheSizeMb(0);
    } catch(e) {
      window.alert("エラーが発生しました。");
    }
  };

  useEffect(() => {
    if (isLoaded) {
      set("bilin_sessions", sessions.map(s => {
         return s;
      })).catch(console.warn);
    }
  }, [sessions, isLoaded]);

  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0];

  useEffect(() => {
    if (rightPaneRef.current && isLoaded) {
      rightPaneRef.current.scrollTop = activeSession.scrollPosition || 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, isLoaded]);

  const updateActiveSession = (updates: Partial<Session>) => {
    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, ...updates } : s));
  };

  const saveSettings = () => {
    localStorage.setItem("bilin_translation_provider", tempTranslationProvider);
    localStorage.setItem("bilin_audio_provider", tempAudioProvider);
    localStorage.setItem("bilin_api_keys", JSON.stringify(tempApiKeys));
    localStorage.setItem("bilin_ai_models", JSON.stringify(tempAiModels));
    localStorage.setItem("bilin_audio_voices", JSON.stringify(tempAudioVoices));
    localStorage.setItem("bilin_target_language", tempLanguage);
    localStorage.setItem("bilin_auto_translate", tempAutoTranslate ? "true" : "false");
    
    setTranslationProvider(tempTranslationProvider);
    setAudioProvider(tempAudioProvider);
    setApiKeys(tempApiKeys);
    setAiModels(tempAiModels);
    setAudioVoices(tempAudioVoices);
    setTargetLanguage(tempLanguage);
    setIsAutoTranslate(tempAutoTranslate);
    setIsSettingsOpen(false);
  };

  const handleAddNewSession = () => {
    const newId = Date.now().toString();
    setSessions(prev => [...prev, {
      id: newId, url: "", title: "", paragraphs: [], iframeContent: "", isFetching: false
    }]);
    setActiveSessionId(newId);
  };

  const handleCloseSession = (idToClose: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => {
      const filtered = prev.filter(s => s.id !== idToClose);
      if (filtered.length === 0) {
        const newId = Date.now().toString();
        setActiveSessionId(newId);
        return [{ id: newId, url: "", title: "", paragraphs: [], iframeContent: "", isFetching: false }];
      }
      if (idToClose === activeSessionId) {
        setActiveSessionId(filtered[filtered.length - 1].id);
      }
      return filtered;
    });
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedSessionId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    
    if (draggedSessionId === id) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isTopHalf = e.clientY < rect.top + rect.height / 2;
    const newPosition = isTopHalf ? "top" : "bottom";

    if (dragOverSessionId !== id || dragOverPosition !== newPosition) {
      setDragOverSessionId(id);
      setDragOverPosition(newPosition);
    }
  };

  const handleDragLeave = (_: React.DragEvent, id: string) => {
    if (dragOverSessionId === id) {
      setDragOverSessionId(null);
      setDragOverPosition(null);
    }
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain") || draggedSessionId;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isTopHalf = e.clientY < rect.top + rect.height / 2;
    
    setDragOverSessionId(null);
    setDragOverPosition(null);
    setDraggedSessionId(null);

    if (!sourceId || sourceId === targetId) {
      return;
    }

    setSessions(prev => {
      const draggedIndex = prev.findIndex(s => s.id === sourceId);
      const targetIndex = prev.findIndex(s => s.id === targetId);
      
      if (draggedIndex === -1 || targetIndex === -1) return prev;
      
      const newSessions = [...prev];
      const draggedItem = newSessions[draggedIndex];
      newSessions.splice(draggedIndex, 1);
      
      let adjustedTargetIndex = targetIndex;
      if (draggedIndex < targetIndex) {
        adjustedTargetIndex--;
      }
      
      if (!isTopHalf) {
        adjustedTargetIndex++;
      }
      
      newSessions.splice(adjustedTargetIndex, 0, draggedItem);
      return newSessions;
    });
  };

  const handleDragEnd = () => {
    setDraggedSessionId(null);
    setDragOverSessionId(null);
    setDragOverPosition(null);
  };


  const loadArticle = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeSession.url) return;

    updateActiveSession({ isFetching: true, paragraphs: [], iframeContent: "", title: "" });
    
    try {
      let html: string = await invoke("fetch_html", { url: activeSession.url });
      
      const processHtml = (htmlStr: string) => {
        const parser = new DOMParser();
        
        // DOMPurifyはデフォルトのHTMLプロファイルにおいて、安全のため<body>以外の要素（<head>や<title>等）を一律削除します。
        // これにより、後続のReadabilityで正確な記事タイトルが取得できない（フォールバックの<h1>抽出にも失敗する）ケースがあります。
        // これを防ぐため、サニタイズ前の生のHTMLからタイトルを抽出しておきます。
        // ここで取得する `rawDoc.title` はDOM要素ではなく純粋なテキスト文字列であり、
        // 最終的にReact側でエスケープされて描画されるため、XSS等のセキュリティリスクはありません。
        const rawDoc = parser.parseFromString(htmlStr, "text/html");
        const originalTitle = rawDoc.title;

        const cleanHtml = DOMPurify.sanitize(htmlStr, { USE_PROFILES: { html: true } });
        const doc = parser.parseFromString(cleanHtml, "text/html");
        
        // Readabilityがタイトルを認識できるように、サニタイズ後のDOMにタイトルを再設定
        if (originalTitle) {
          doc.title = originalTitle;
        }

        const reader = new Readability(doc);
        const article = reader.parse();

        const extracted: Paragraph[] = [];
        let pageTitle = "Untitled Article";
        
        if (article && article.content) {
          pageTitle = article.title || originalTitle || "Untitled Article";
          const contentDoc = parser.parseFromString(article.content, "text/html");
          const query = 'p, h1, h2, h3, h4, li, blockquote';
          let elements = Array.from(contentDoc.querySelectorAll(query)).filter(el => !el.closest('nav'));
          
          // 内部にさらに抽出対象の要素を持つ要素（例: <li>の中に<p>がある場合など）を除外することで、重複カードの生成を防ぐ
          elements = elements.filter(el => el.querySelector(query) === null);
          
          elements.forEach((el, index) => {
            const text = el.textContent?.trim();
            if (text && text.length > 20) {
              extracted.push({
                id: `p-${index}`,
                originalText: text,
                translatedText: null,
                isLoading: false,
                isAudioLoading: false,
                isPlaying: false,
                isPaused: false,
                isCached: false,
              });
            }
          });
        }
        return { article, extracted, pageTitle };
      };

      let { article, extracted, pageTitle } = processHtml(html);

      if (extracted.length === 0 && !activeSession.url.includes("localhost") && !activeSession.url.includes("127.0.0.1")) {
        try {
          console.log("No content found (possibly an SPA). Retrying with Jina Reader...");
          const jinaHtml: string = await invoke("fetch_html_jina", { url: activeSession.url });
          const jinaResult = processHtml(jinaHtml);
          if (jinaResult.extracted.length > 0) {
            // Jina Readerで取得したHTML（レンダリング済み）からscriptタグを削除
            // これによりReactなどのSPAがiframe内で再度起動し、ルーティング不一致で404画面に上書きされるのを防ぐ
            const parser = new DOMParser();
            const doc = parser.parseFromString(jinaHtml, "text/html");
            doc.querySelectorAll('script').forEach(s => s.remove());
            
            html = doc.documentElement.outerHTML;
            article = jinaResult.article;
            extracted = jinaResult.extracted;
            pageTitle = jinaResult.pageTitle;
          }
        } catch (e) {
          console.warn("Jina Reader fallback failed", e);
        }
      }

      if (article && article.content) {
        
        // --- 注入 (インジェクション) 用 HTML の生成 ---
        const urlObj = new URL(activeSession.url);
        const baseUrl = urlObj.origin + urlObj.pathname;

        const injectionScript = `
          <base href="${baseUrl}">
          <script>
            // ブラウザのデフォルト選択ハイライトを青色に上書き
            const style = document.createElement('style');
            style.innerHTML = '::selection { background: rgba(59, 130, 246, 0.4) !important; color: inherit; }';
            document.head.appendChild(style);

            document.addEventListener('click', (e) => {
               const a = e.target.closest('a');
               if (a) {
                  const hrefAttr = a.getAttribute('href');
                  if (hrefAttr && hrefAttr.startsWith('#')) {
                     e.preventDefault();
                     try {
                        const targetEl = document.querySelector(hrefAttr) || document.getElementById(hrefAttr.substring(1));
                        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth' });
                     } catch(err) {}
                     return;
                  } else if (hrefAttr && !hrefAttr.startsWith('javascript:')) {
                     e.preventDefault();
                     window.open(a.href, '_blank');
                     return;
                  }
               }

               const target = e.target.closest('p, h1, h2, h3, h4, li, blockquote, div');
               if (target) {
                  const text = target.textContent;
                  if (text && text.trim().length > 0) {
                     window.parent.postMessage({ type: 'IFRAME_CLICK', text: text }, '*');
                  }
               }
            });

            let scrollTimeout;
            window.addEventListener('scroll', () => {
              if (scrollTimeout) clearTimeout(scrollTimeout);
              scrollTimeout = setTimeout(() => {
                 window.parent.postMessage({ type: 'IFRAME_SCROLL', scrollY: window.scrollY }, '*');
              }, 500);
            });

            window.addEventListener('message', (event) => {
              if (event.data && event.data.type === 'RESTORE_SCROLL') {
                 window.scrollTo(0, event.data.scrollY || 0);
                 return;
              }
              if (event.data && event.data.type === 'HIGHLIGHT') {
                 const text = event.data.text;
                 if (!text) return;
                 
                 // 以前のハイライトを削除
                 document.querySelectorAll('.bilin-highlight-fx').forEach(el => {
                    el.classList.remove('bilin-highlight-fx');
                    el.style.backgroundColor = '';
                    el.style.boxShadow = '';
                 });

                 const normalize = (s) => s.replace(/\\s+/g, ' ').trim();
                 const normText = normalize(text);

                 // nav要素内の要素(TOCなど)は検索対象から除外する
                 const elements = Array.from(document.body.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, div'))
                    .filter(el => !el.closest('nav'));
                 let bestMatch = null;
                 let bestScore = 0;

                 // 要素単位でのマッチングを行う
                 for (const el of elements) {
                    const normElText = normalize(el.textContent || '');
                    if (normElText.length < 10) continue;

                    if (normElText === normText) {
                       bestMatch = el;
                       bestScore = 1;
                       break;
                    }

                    if (normElText.includes(normText) || normText.includes(normElText)) {
                       const ratio = Math.min(normElText.length, normText.length) / Math.max(normElText.length, normText.length);
                       if (ratio > bestScore) {
                          bestScore = ratio;
                          bestMatch = el;
                       }
                    }
                 }

                 // 完全にも包含にもマッチしなかった場合、先頭と末尾のテキストで包含を探る
                 if (!bestMatch && normText.length > 40) {
                    const shortText = normText.substring(0, 30);
                    const tailText = normText.substring(normText.length - 30);
                    for (const el of elements) {
                       const normElText = normalize(el.textContent || '');
                       if (normElText.includes(shortText) && normElText.includes(tailText)) {
                          const ratio = normText.length / Math.max(normElText.length, normText.length);
                          if (ratio > bestScore) {
                             bestScore = ratio;
                             bestMatch = el;
                          }
                       }
                    }
                 }

                 if (bestMatch && bestScore > 0.4) {
                    // スコアが十分高ければ、その要素自体にハイライト色をつけてスクロール
                    bestMatch.classList.add('bilin-highlight-fx');
                    bestMatch.style.backgroundColor = 'rgba(59, 130, 246, 0.15)';
                    bestMatch.style.boxShadow = '0 0 0 4px rgba(59, 130, 246, 0.15)';
                    bestMatch.style.borderRadius = '4px';
                    bestMatch.style.transition = 'all 0.4s ease';
                    bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
                 } else {
                    // 最終フォールバックとしてブラウザのデフォルト検索
                    const sel = window.getSelection();
                    if(sel) {
                       sel.removeAllRanges();
                       sel.collapse(document.body, 0);
                    }
                    const shortTextFallback = text.length > 40 ? text.substring(0, 40) : text;
                    let found = window.find(text, false, false, true, false, false, false);
                    if (!found && text.length > 40) {
                       found = window.find(shortTextFallback, false, false, true, false, false, false);
                    }
                    if (found) {
                       setTimeout(() => window.scrollBy(0, -100), 50);
                    }
                 }
              }
            });
          </script>
        `;

        let finalHtml = html;
        if (finalHtml.toLowerCase().includes('<head>')) {
           finalHtml = finalHtml.replace(/<head>/i, '<head>' + injectionScript);
        } else {
           finalHtml = injectionScript + finalHtml;
        }

        updateActiveSession({ title: pageTitle, paragraphs: [...extracted], iframeContent: finalHtml });

        extracted.forEach(async (p) => {
          try {
            const cacheKey = getCacheKey(p.originalText, targetLanguage);
            const cachedTranslation = await getCacheRecord(cacheKey);
            if (cachedTranslation && typeof cachedTranslation === "string") {
              setSessions(prev => prev.map(s => {
                if(s.id === activeSessionId) {
                  return { ...s, paragraphs: s.paragraphs.map(pr => pr.id === p.id ? { ...pr, translatedText: cachedTranslation, isCached: true} : pr) };
                }
                return s;
              }));
            }
          } catch(err) {}
        });
      }
    } catch (err) {
      console.error(err);
      window.alert("ページの取得に失敗しました。\n" + String(err));
    } finally {
      setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, isFetching: false} : s));
    }
  };

  const handleTranslate = async (index: number, isAuto: boolean = false) => {
    const key = apiKeys[translationProvider];
    const model = aiModels[translationProvider];

    if (!key || !model) {
      if (isAuto) return;
      setTempTranslationProvider(translationProvider);
      setTempApiKeys(apiKeys);
      setTempAiModels(aiModels);
      setTempLanguage(targetLanguage);
      setIsSettingsOpen(true);
      if (!key) window.alert("翻訳プロバイダーのAPIキーが設定されていません。左の歯車アイコンから設定してください。");
      else window.alert("翻訳プロバイダーのAIモデルが選択されていません。");
      return;
    }

    const p = activeSession.paragraphs[index];
    if (p.translatedText || p.isLoading) return;

    const cacheKey = getCacheKey(p.originalText, targetLanguage);
    try {
      const cachedTranslation = await getCacheRecord(cacheKey);
      if (cachedTranslation && typeof cachedTranslation === "string") {
        setSessions(prev => prev.map(s => s.id === activeSessionId ? {
          ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, translatedText: cachedTranslation, isLoading: false, isCached: true } : pr)
        } : s));
        return;
      }
    } catch(err) {}

    setSessions(prev => prev.map(s => s.id === activeSessionId ? {
      ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isLoading: true } : pr)
    } : s));

    try {
      let translated = "";
      const systemPrompt = `You are a professional translator. Translate the following English text to ${targetLanguage} accurately, naturally, and contextually. Do not output anything other than the translated text.`;

      if (translationProvider === "openai") {
        const openai = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
        const response = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: p.originalText }
          ],
        });
        translated = response.choices[0]?.message?.content || "（翻訳に失敗しました）";
      } else if (translationProvider === "anthropic") {
        const anthropic = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, defaultHeaders: { "anthropic-dangerously-allow-browser": "true" } });
        const response = await anthropic.messages.create({
          model: model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: p.originalText }]
        });
        const contentBlock = response.content[0];
        if (contentBlock && contentBlock.type === 'text') {
           translated = contentBlock.text;
        } else {
           translated = "（翻訳に失敗しました）";
        }
      } else if (translationProvider === "gemini") {
        const genAI = new GoogleGenAI({ apiKey: key });
        const response = await genAI.models.generateContent({
           model: model,
           contents: p.originalText,
           config: { systemInstruction: systemPrompt }
        });
        translated = response.text || "（翻訳に失敗しました）";
      }
      
      try {
        await setCacheRecord(getCacheKey(p.originalText, targetLanguage), translated);
      } catch(err) { }

      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, translatedText: translated, isLoading: false } : pr)
      } : s));
    } catch (err: any) {
      window.alert("翻訳中にエラーが発生しました: " + err.message);
      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isLoading: false } : pr)
      } : s));
    }
  };

  const handleListen = async (index: number) => {
    const key = apiKeys[audioProvider];
    const voice = audioVoices[audioProvider];

    if (!key) {
      setTempAudioProvider(audioProvider);
      setTempApiKeys(apiKeys);
      setTempAudioVoices(audioVoices);
      setIsSettingsOpen(true);
      window.alert("音声プロバイダーのAPIキーが設定されていません。");
      return;
    }

    const p = activeSession.paragraphs[index];
    if (p.isAudioLoading || p.isPlaying || p.isPaused) return;

    setSessions(prev => prev.map(s => s.id === activeSessionId ? {
      ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isAudioLoading: true } : pr)
    } : s));

    try {
      let cachedData: any = await getCacheRecord(`audio_${audioProvider}_${p.originalText}`);
      let blob: Blob;

      if (!cachedData || (!(cachedData instanceof Blob) && !(cachedData instanceof ArrayBuffer) && !(cachedData instanceof Uint8Array))) {
        if (audioProvider === "openai") {
           const openai = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
           const mp3 = await openai.audio.speech.create({
             model: "tts-1",
             voice: voice as any || "alloy",
             input: p.originalText,
           });
           const buffer = await mp3.arrayBuffer();
           blob = new Blob([buffer], { type: "audio/mpeg" });
        } else if (audioProvider === "gemini") {
           const ai = new GoogleGenAI({ apiKey: key });
           const response = await ai.models.generateContent({
             model: "gemini-2.5-flash-preview-tts",
             contents: p.originalText,
             config: {
               responseModalities: ["AUDIO"],
               speechConfig: {
                 voiceConfig: {
                   prebuiltVoiceConfig: {
                     voiceName: voice || "Kore"
                   }
                 }
               }
             }
           });
           const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
           if (!data) throw new Error("Audio data not found in response");
           const binaryString = window.atob(data);
           const len = binaryString.length;
           const bytes = new Uint8Array(len);
           for (let i = 0; i < len; i++) {
               bytes[i] = binaryString.charCodeAt(i);
           }
           blob = new Blob([bytes], { type: "audio/wav" });
        } else {
           throw new Error("Unsupported Audio Provider");
        }
        
        try {
          await setCacheRecord(`audio_${audioProvider}_${p.originalText}`, blob);
        } catch (e) {}
      } else {
        blob = cachedData instanceof Blob ? cachedData : new Blob([cachedData as BlobPart], { type: "audio/mpeg" });
      }

      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audioRefs.current[p.id] = audio;

      audio.onended = () => {
        setSessions(prev => prev.map(s => s.id === activeSessionId ? {
          ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isPlaying: false, isPaused: false } : pr)
        } : s));
        URL.revokeObjectURL(audioUrl);
        delete audioRefs.current[p.id];
      };

      await audio.play();
      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isPlaying: true, isAudioLoading: false, isPaused: false } : pr)
      } : s));

    } catch (err: any) {
      window.alert("音声の生成中にエラーが発生しました: " + err.message);
      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isAudioLoading: false, isPlaying: false, isPaused: false } : pr)
      } : s));
    }
  };

  const handleAudioToggle = (index: number) => {
    const p = activeSession.paragraphs[index];
    const audio = audioRefs.current[p.id];
    if (!audio) return;

    if (p.isPlaying) {
      audio.pause();
      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isPlaying: false, isPaused: true } : pr)
      } : s));
    } else if (p.isPaused) {
      audio.play().catch(console.error);
      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isPlaying: true, isPaused: false } : pr)
      } : s));
    }
  };

  const handleAudioStop = (index: number) => {
    const p = activeSession.paragraphs[index];
    const audio = audioRefs.current[p.id];
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      delete audioRefs.current[p.id];
    }
    setSessions(prev => prev.map(s => s.id === activeSessionId ? {
      ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isPlaying: false, isPaused: false } : pr)
    } : s));
  };

  const handleParagraphClick = (text: string, pId: string) => {
    setActiveParagraphId(pId);
    if (iframeRef.current && iframeRef.current.contentWindow) {
       iframeRef.current.contentWindow.postMessage({ type: 'HIGHLIGHT', text }, '*');
    }
  };

  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'IFRAME_SCROLL') {
        setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, iframeScrollPosition: event.data.scrollY } : s));
      } else if (event.data && event.data.type === 'IFRAME_CLICK') {
        const text = event.data.text;
        if (!text) return;

        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
        const normText = normalize(text);

        let bestMatchIdx = -1;
        let bestScore = 0;

        activeSession.paragraphs.forEach((p, idx) => {
           const normP = normalize(p.originalText);
           // Exact match
           if (normP === normText) {
              bestMatchIdx = idx;
              bestScore = 1;
              return;
           }
           // Substring match
           if (normP.includes(normText) || normText.includes(normP)) {
              const ratio = Math.min(normP.length, normText.length) / Math.max(normP.length, normText.length);
              if (ratio > bestScore) {
                 bestScore = ratio;
                 bestMatchIdx = idx;
              }
           }
        });

        // Fallback matching with partial ends
        if (bestMatchIdx === -1 && normText.length > 40) {
           const shortText = normText.substring(0, 30);
           const tailText = normText.substring(normText.length - 30);
           activeSession.paragraphs.forEach((p, idx) => {
              const normP = normalize(p.originalText);
              if (normP.includes(shortText) && normP.includes(tailText)) {
                 const ratio = normP.length / Math.max(normP.length, normText.length);
                 if (ratio > bestScore) {
                    bestScore = ratio;
                    bestMatchIdx = idx;
                 }
              }
           });
        }

        if (bestMatchIdx !== -1 && bestScore > 0.4) {
           const pId = activeSession.paragraphs[bestMatchIdx].id;
           setActiveParagraphId(pId);
           const el = document.getElementById(`card-${pId}`);
           if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
           }
           if (iframeRef.current && iframeRef.current.contentWindow) {
              iframeRef.current.contentWindow.postMessage({ type: 'HIGHLIGHT', text: activeSession.paragraphs[bestMatchIdx].originalText }, '*');
           }
        }
      }
    };

    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, [activeSessionId, activeSession.paragraphs]);

  if (!isLoaded) return null;

  return (
    <div className="flex h-screen w-screen bg-neutral-50 text-neutral-900 overflow-hidden font-sans">
      {/* 垂直タブ (左ペイン) */}
      <aside className="w-60 flex-shrink-0 bg-white border-r border-neutral-200 flex flex-col py-4 z-20 shadow-sm relative overflow-y-hidden">
        <div className="px-4 mb-5 flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold shadow-md shrink-0">Bi</div>
          <span className="font-bold text-neutral-800 tracking-wide text-lg">Bilin</span>
        </div>

        <div className="flex-1 px-3 py-2 space-y-2 overflow-y-auto">
          {sessions.map((s, idx) => {
            const isActive = s.id === activeSessionId;
            let domain = "";
            try { if (s.url) domain = new URL(s.url).hostname; } catch(e) {}
            const faviconUrl = domain ? `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(domain)}` : "";
            
            const isDropTop = dragOverSessionId === s.id && dragOverPosition === "top";
            const isDropBottom = dragOverSessionId === s.id && dragOverPosition === "bottom";
            
            return (
              <div 
                key={s.id}
                draggable
                onDragStart={(e) => handleDragStart(e, s.id)}
                onDragOver={(e) => handleDragOver(e, s.id)}
                onDragLeave={(e) => handleDragLeave(e, s.id)}
                onDrop={(e) => handleDrop(e, s.id)}
                onDragEnd={handleDragEnd}
                onClick={() => setActiveSessionId(s.id)}
                className={`group w-full h-10 rounded-xl flex items-center px-3 cursor-pointer transition relative
                  ${isActive ? 'bg-blue-50 border border-blue-100 text-blue-700 shadow-sm' : 'bg-transparent text-neutral-600 border border-transparent hover:bg-neutral-100 hover:text-neutral-900'}
                  ${draggedSessionId === s.id ? 'opacity-40 border-dashed border-neutral-300' : ''}
                  ${isDropTop ? 'before:absolute before:-top-[5px] before:left-0 before:right-0 before:h-[3px] before:bg-blue-500 before:rounded-full before:z-10' : ''}
                  ${isDropBottom ? 'after:absolute after:-bottom-[5px] after:left-0 after:right-0 after:h-[3px] after:bg-blue-500 after:rounded-full after:z-10' : ''}`}
                title={s.title || `Session ${idx + 1}`}
              >
                {faviconUrl ? (
                  <img src={faviconUrl} alt="favicon" className="w-4 h-4 rounded-sm flex-shrink-0 mr-3 opacity-90" />
                ) : (
                  <Globe size={16} className={`flex-shrink-0 mr-3 ${isActive ? 'text-blue-500' : 'text-neutral-400'}`} />
                )}
                <span className="text-sm font-medium truncate flex-1">
                  {s.title ? s.title : s.url && s.isFetching ? "Loading..." : s.url ? "Untitled" : "New Tab"}
                </span>
                
                <button
                  onClick={(e) => handleCloseSession(s.id, e)}
                  title="Close Tab"
                  className="ml-2 w-6 h-6 flex items-center justify-center text-neutral-400 hover:text-red-500 hover:bg-red-50 rounded-md transition opacity-0 group-hover:opacity-100 flex-shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}

          <div 
            onClick={handleAddNewSession}
            className="w-full h-10 rounded-xl border border-dashed border-neutral-300 flex items-center justify-center text-neutral-500 cursor-pointer transition hover:bg-neutral-100 hover:border-neutral-400 mt-2"
          >
            <Plus size={18} className="mr-2" />
            <span className="text-sm font-medium">New Tab</span>
          </div>
        </div>
        
        <div className="px-3 mt-4 pt-4 border-t border-neutral-100">
          <div 
            onClick={() => {
              setTempTranslationProvider(translationProvider);
              setTempAudioProvider(audioProvider);
              setTempApiKeys(apiKeys);
              setTempAiModels(aiModels);
              setTempAudioVoices(audioVoices);
              setTempLanguage(targetLanguage);
              setTempAutoTranslate(isAutoTranslate);
              setIsSettingsOpen(true);
            }}
            className={`w-full h-10 rounded-xl hover:bg-neutral-100 flex items-center px-3 cursor-pointer transition text-sm font-medium ${!apiKeys[translationProvider] ? 'text-red-500' : 'text-neutral-600'}`}
          >
            <Settings size={18} className="mr-3" />
            Settings
          </div>
        </div>
      </aside>

      {/* 中央ペイン (オリジナルビュー) */}
      <main className="flex-1 flex flex-col bg-neutral-100 min-w-[300px] border-r border-neutral-200 shadow-[2px_0_10px_-5px_rgba(0,0,0,0.1)] z-10 relative">
        <form onSubmit={loadArticle} className="h-14 bg-white border-b border-neutral-200 flex items-center px-4 shadow-sm z-10 shrink-0">
          <div className="w-full flex bg-neutral-100 border border-neutral-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 transition-all">
            <div className="flex items-center justify-center pl-3 text-neutral-400">
              <Globe size={16} />
            </div>
            <input 
              type="url" 
              value={activeSession.url}
              onChange={(e) => updateActiveSession({ url: e.target.value })}
              placeholder="ニュースやブログ記事のURLを入力" 
              className="flex-1 bg-transparent px-3 py-2 text-sm focus:outline-none placeholder-neutral-400"
            />
            <button 
              type="submit" 
              disabled={!activeSession.url || activeSession.isFetching}
              className="bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:bg-neutral-300 disabled:cursor-not-allowed transition"
            >
              {activeSession.isFetching ? "ローディング..." : "開く"}
            </button>
          </div>
        </form>

        <div className="flex-1 overflow-hidden relative bg-white flex shadow-inner">
            {activeSession.iframeContent ? (
              <iframe 
                ref={iframeRef}
                srcDoc={activeSession.iframeContent} 
                className="w-full h-full border-none"
                sandbox="allow-scripts allow-same-origin allow-popups"
                title="Original Content"
                onLoad={() => {
                  if (iframeRef.current && iframeRef.current.contentWindow) {
                     iframeRef.current.contentWindow.postMessage({ type: 'RESTORE_SCROLL', scrollY: activeSession.iframeScrollPosition || 0 }, '*');
                  }
                }}
              />
            ) : activeSession.title ? (
              <div className="flex flex-col items-center justify-center w-full p-8 text-center max-w-lg mx-auto">
                <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-500 mb-6 border border-blue-100 shadow-sm">
                  <Globe size={32} />
                </div>
                <h1 className="text-xl font-bold text-neutral-800 mb-2">{activeSession.title}</h1>
                <p className="text-neutral-500 text-sm">表示できないページの場合はこちらのアウトラインを利用してください。右パネルから学習を進められます。</p>
              </div>
            ) : (
              <div className="text-neutral-400 flex flex-col items-center justify-center w-full">
                <Globe size={48} className="mb-4 opacity-50 stroke-1" />
                <span className="text-sm font-medium">オリジナルサイトのビュー</span>
              </div>
            )}
        </div>
      </main>

      {/* 右ペイン (翻訳・リーディングカード) */}
      <aside className="w-[45%] min-w-[380px] max-w-[600px] bg-neutral-50 flex flex-col relative">
        <div className="h-14 bg-white border-b border-neutral-200 flex items-center justify-between px-5 z-10 shrink-0 shadow-sm">
          <span className="font-semibold text-neutral-800 flex items-center space-x-2">
            <span>Reading & Translation</span>
            {!apiKeys[translationProvider] && (
              <span className="bg-red-100 text-red-600 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide">
                API Key Required
              </span>
            )}
          </span>
          <div className="flex items-center space-x-4">
            <label className="flex items-center space-x-2 cursor-pointer group">
              <div className="relative flex items-center">
                <input 
                  type="checkbox" 
                  className="sr-only" 
                  checked={isAutoTranslate}
                  onChange={(e) => {
                     setIsAutoTranslate(e.target.checked);
                     localStorage.setItem("bilin_auto_translate", e.target.checked ? "true" : "false");
                     setTempAutoTranslate(e.target.checked);
                  }}
                />
                <div className={`block w-9 h-5 rounded-full transition-colors duration-200 ease-in-out ${isAutoTranslate ? 'bg-blue-500' : 'bg-neutral-300 group-hover:bg-neutral-400'}`}></div>
                <div className={`absolute left-0.5 bg-white w-4 h-4 rounded-full transition-transform duration-200 ease-in-out shadow-sm ${isAutoTranslate ? 'translate-x-4' : 'translate-x-0'}`}></div>
              </div>
              <span className={`text-xs font-medium transition-colors ${isAutoTranslate ? 'text-blue-700' : 'text-neutral-500'}`}>
                Auto Translate
              </span>
            </label>
            <span className="text-xs text-neutral-400 font-medium">{activeSession.paragraphs.length} paragraphs</span>
          </div>
        </div>
        
        <div 
          ref={rightPaneRef}
          onScroll={(e) => {
            const scrollTop = e.currentTarget.scrollTop;
            if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
            scrollTimeoutRef.current = setTimeout(() => {
               setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, scrollPosition: scrollTop } : s));
            }, 500);
          }}
          className="flex-1 overflow-y-auto p-5 py-6 space-y-6"
        >
          {activeSession.paragraphs.length === 0 && !activeSession.isFetching && (
            <div className="h-full flex flex-col items-center justify-center text-neutral-400 text-sm text-center px-8 border-2 border-dashed border-neutral-200/50 rounded-2xl mx-2">
              左側でURLを入力するか、セッションを選択してください
            </div>
          )}

          {activeSession.paragraphs.map((p, i) => {
            const isSelected = activeParagraphId === p.id;
            return (
            <ObserverWrapper 
              key={p.id} 
              index={i} 
              isAutoTranslate={isAutoTranslate}
              onIntersect={(idx) => {
                if (isAutoTranslate && apiKeys[translationProvider] && aiModels[translationProvider] && !p.translatedText && !p.isLoading) {
                  handleTranslate(idx, true);
                }
              }}
            >
              <div 
                id={`card-${p.id}`}
                onClick={() => handleParagraphClick(p.originalText, p.id)}
                className={`rounded-2xl p-5 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.05)] border transition-all hover:shadow-md hover:border-blue-300 group relative overflow-hidden cursor-pointer ${isSelected ? 'bg-blue-50/50 border-blue-400 ring-2 ring-blue-500/50' : 'bg-white border-neutral-200/60'}`}
              >
              {p.isPlaying && (
                <div className="absolute top-0 left-0 w-full h-1 bg-blue-500 animate-pulse" />
              )}
              <div className="flex items-center justify-between mb-3">
                 <span className="text-xs font-bold text-neutral-400 group-hover:text-blue-500 transition-colors">P{i + 1}</span>
                 {p.isCached && (
                   <span className="flex items-center space-x-1 text-[10px] font-bold text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full">
                     <CheckCircle2 size={12} />
                     <span>Cached</span>
                   </span>
                 )}
              </div>
              <p className={`font-serif text-[1.05rem] leading-relaxed mb-4 text-justify transition-colors ${p.isPlaying ? 'text-blue-900' : 'text-neutral-800'}`}>
                {p.originalText}
              </p>
              <div className="h-px w-full bg-neutral-100 mb-4" />
              
              <div className="flex flex-col space-y-3">
                {!p.translatedText ? (
                   <button 
                    onClick={(e) => { e.stopPropagation(); handleTranslate(i); }}
                    disabled={p.isLoading}
                    className="flex items-center space-x-1.5 text-blue-600 bg-blue-50/50 hover:bg-blue-100/50 px-3 py-2 rounded-xl text-sm font-medium transition cursor-pointer self-start border border-blue-100/50 disabled:opacity-50"
                  >
                    {p.isLoading ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />}
                    <span>{p.isLoading ? "翻訳中..." : "翻訳を表示"}</span>
                  </button>
                ) : (
                  <p className="text-neutral-600 leading-relaxed text-sm">
                    {p.translatedText}
                  </p>
                )}

                <div className="flex justify-end pt-2 mt-2 border-t border-transparent group-hover:border-neutral-50 transition-colors">
                  {p.isPlaying || p.isPaused ? (
                    <div className="flex items-center space-x-2">
                       <button
                         onClick={(e) => { e.stopPropagation(); handleAudioToggle(i); }}
                         className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition shadow-sm cursor-pointer border ${p.isPlaying ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-neutral-50 text-neutral-600 hover:bg-neutral-100 border-neutral-200'}`}
                       >
                         {p.isPlaying ? <Pause size={15} className="fill-current text-blue-600" /> : <Play size={15} className="fill-current" />}
                         <span>{p.isPlaying ? "Pause" : "Resume"}</span>
                       </button>
                       <button
                         onClick={(e) => { e.stopPropagation(); handleAudioStop(i); }}
                         className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition shadow-sm cursor-pointer border bg-red-50 text-red-600 hover:bg-red-100 border-red-200"
                       >
                         <Square size={13} className="fill-current" />
                         <span>Stop</span>
                       </button>
                    </div>
                  ) : (
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleListen(i); }}
                      disabled={p.isAudioLoading}
                      className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition shadow-sm cursor-pointer border
                        ${p.isAudioLoading
                          ? 'bg-neutral-50 text-neutral-400 border-neutral-100'
                          : 'bg-neutral-50 text-neutral-500 hover:text-blue-600 hover:bg-blue-50 border-neutral-100'}
                        disabled:opacity-50`}
                    >
                      {p.isAudioLoading ? (
                        <Loader2 size={15} className="animate-spin text-neutral-400" />
                      ) : (
                        <Play size={15} className="fill-current" />
                      )}
                      <span>{p.isAudioLoading ? "生成中..." : "Listen"}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
            </ObserverWrapper>
            );
          })}
        </div>
      </aside>

      {/* 設定モーダル */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-screen">
            <div className="h-14 border-b border-neutral-100 flex items-center justify-between px-6 bg-neutral-50/50 shrink-0">
              <h2 className="font-semibold text-neutral-800 flex items-center space-x-2">
                <Settings size={18} className="text-neutral-500" />
                <span>設定 (Settings)</span>
              </h2>
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 transition"
              >
                <X size={20} />
              </button>
            </div>
            
                        <div className="p-6 space-y-6 overflow-y-auto">
              {/* Translation Settings */}
              <div className="p-4 rounded-xl border border-neutral-200 bg-neutral-50/50 space-y-4">
                <h3 className="font-semibold text-neutral-800 text-sm">翻訳設定 (Translation)</h3>
                
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1.5">Provider</label>
                  <select 
                    value={tempTranslationProvider}
                    onChange={(e) => setTempTranslationProvider(e.target.value as TranslationProvider)}
                    className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition cursor-pointer"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="gemini">Google (Gemini)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1.5">API Key</label>
                  <input 
                    type="password"
                    value={tempApiKeys[tempTranslationProvider] || ""}
                    onChange={(e) => setTempApiKeys(prev => ({ ...prev, [tempTranslationProvider]: e.target.value }))}
                    placeholder="API Key..."
                    className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1.5 flex justify-between items-center">
                    <span>AI Model</span>
                    {tempApiKeys[tempTranslationProvider] && (
                      <button 
                        onClick={fetchModels} 
                        disabled={isFetchingModels}
                        className="text-[10px] text-blue-600 hover:text-blue-700 flex items-center space-x-1 disabled:opacity-50"
                      >
                        {isFetchingModels ? <Loader2 size={10} className="animate-spin" /> : null}
                        <span>リスト更新</span>
                      </button>
                    )}
                  </label>
                  {tempTranslationProvider === "openai" ? (
                    <select 
                      value={tempAiModels.openai || ""}
                      onChange={(e) => setTempAiModels(prev => ({ ...prev, openai: e.target.value }))}
                      className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition cursor-pointer"
                    >
                      {availableModels.openai.map(m => <option key={m} value={m}>{m}</option>)}
                      {!availableModels.openai.includes(tempAiModels.openai) && tempAiModels.openai && <option value={tempAiModels.openai}>{tempAiModels.openai}</option>}
                    </select>
                  ) : tempTranslationProvider === "anthropic" ? (
                    <select 
                      value={tempAiModels.anthropic || "claude-3-7-sonnet-latest"}
                      onChange={(e) => setTempAiModels(prev => ({ ...prev, anthropic: e.target.value }))}
                      className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition cursor-pointer"
                    >
                      {availableModels.anthropic.length > 0 ? (
                         availableModels.anthropic.map(m => <option key={m} value={m}>{m}</option>)
                      ) : (
                         <>
                           <option value="claude-3-7-sonnet-latest">Claude 3.7 Sonnet Default</option>
                           <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                           <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
                         </>
                      )}
                      {availableModels.anthropic.length > 0 && !availableModels.anthropic.includes(tempAiModels.anthropic) && tempAiModels.anthropic && <option value={tempAiModels.anthropic}>{tempAiModels.anthropic}</option>}
                    </select>
                  ) : (
                    <select 
                      value={tempAiModels.gemini || "gemini-2.5-pro"}
                      onChange={(e) => setTempAiModels(prev => ({ ...prev, gemini: e.target.value }))}
                      className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition cursor-pointer"
                    >
                      {availableModels.gemini.length > 0 ? (
                         availableModels.gemini.map(m => <option key={m} value={m}>{m}</option>)
                      ) : (
                         <>
                           <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                           <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                           <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                         </>
                      )}
                      {availableModels.gemini.length > 0 && !availableModels.gemini.includes(tempAiModels.gemini) && tempAiModels.gemini && <option value={tempAiModels.gemini}>{tempAiModels.gemini}</option>}
                    </select>
                  )}
                </div>
              </div>

              {/* Audio Settings Node */}
              <div className="p-4 rounded-xl border border-neutral-200 bg-neutral-50/50 space-y-4">
                <h3 className="font-semibold text-neutral-800 text-sm">音声設定 (Text-to-Speech)</h3>
                
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1.5">Provider</label>
                  <select 
                    value={tempAudioProvider}
                    onChange={(e) => setTempAudioProvider(e.target.value as AudioProvider)}
                    className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition cursor-pointer"
                  >
                    <option value="openai">OpenAI (TTS-1)</option>
                    <option value="gemini">Google (Gemini TTS)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1.5">API Key</label>
                  <input 
                    type="password"
                    value={tempApiKeys[tempAudioProvider] || ""}
                    onChange={(e) => setTempApiKeys(prev => ({ ...prev, [tempAudioProvider]: e.target.value }))}
                    placeholder="API Key..."
                    className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1.5">Voice</label>
                  {tempAudioProvider === "openai" ? (
                    <select 
                      value={tempAudioVoices.openai || "alloy"}
                      onChange={(e) => setTempAudioVoices(prev => ({ ...prev, openai: e.target.value }))}
                      className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition cursor-pointer"
                    >
                      <option value="alloy">Alloy (Neutral)</option>
                      <option value="echo">Echo (Male)</option>
                      <option value="fable">Fable (British Male)</option>
                      <option value="onyx">Onyx (Deep Male)</option>
                      <option value="nova">Nova (Female)</option>
                      <option value="shimmer">Shimmer (Soft Female)</option>
                    </select>
                  ) : (
                    <select 
                      value={tempAudioVoices.gemini || "Kore"}
                      onChange={(e) => setTempAudioVoices(prev => ({ ...prev, gemini: e.target.value }))}
                      className="w-full bg-white border border-neutral-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 transition cursor-pointer"
                    >
                      <option value="Aoede">Aoede</option>
                      <option value="Charon">Charon</option>
                      <option value="Fenrir">Fenrir</option>
                      <option value="Kore">Kore</option>
                      <option value="Puck">Puck</option>
                      <option value="Calliope">Calliope</option>
                    </select>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">翻訳先の言語 (Target Language)</label>
                <select 
                  value={tempLanguage}
                  onChange={(e) => setTempLanguage(e.target.value)}
                  className="w-full bg-neutral-50 border border-neutral-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition cursor-pointer"
                >
                  <option value="Japanese">Japanese (日本語)</option>
                  <option value="Chinese (Simplified)">Chinese (簡体字)</option>
                  <option value="Chinese (Traditional)">Chinese (繁体字)</option>
                  <option value="Korean">Korean (韓国語)</option>
                  <option value="Spanish">Spanish (スペイン語)</option>
                  <option value="French">French (フランス語)</option>
                  <option value="German">German (ドイツ語)</option>
                  <option value="Italian">Italian (イタリア語)</option>
                </select>
              </div>



              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5 flex justify-between items-center">
                  <span>Auto Translation (自動翻訳)</span>
                  <label className="cursor-pointer relative inline-flex items-center">
                      <input 
                        type="checkbox" 
                        className="sr-only peer"
                        checked={tempAutoTranslate}
                        onChange={(e) => setTempAutoTranslate(e.target.checked)}
                      />
                      <div className="w-10 h-5 bg-neutral-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </label>
                <p className="text-xs text-neutral-500 mt-1.5 leading-relaxed">
                  カードが画面に表示されたタイミングで自動的に翻訳を実行します。APIの消費量にご注意ください。
                </p>
              </div>

              <div>
                 <label className="block text-sm font-medium text-neutral-700 mb-1.5">データ管理 (Data Management)</label>
                 <div className="flex items-center justify-between bg-neutral-50 px-4 py-3 rounded-lg border border-neutral-200">
                    <div>
                      <div className="text-sm font-medium text-neutral-800">キャッシュサイズ</div>
                      <div className="text-xs text-neutral-500">翻訳テキストや音声の保存量</div>
                    </div>
                    <div className="flex items-center space-x-3">
                      <span className="text-sm font-mono text-neutral-600 font-medium">
                        {cacheSizeMb !== null ? `${cacheSizeMb} MB` : "計算中..."}
                      </span>
                      <button 
                        onClick={clearAllCaches}
                        className="px-3 py-1.5 bg-white border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium rounded-md transition"
                      >
                        クリア
                      </button>
                    </div>
                 </div>
                 <p className="text-xs text-neutral-500 mt-2 leading-relaxed">
                   不要になった古い音声や翻訳データは、アプリご利用時（待機中）に裏側で自動的に削除されます。
                 </p>
              </div>
            </div>
            
            <div className="bg-neutral-50 px-6 py-4 border-t border-neutral-100 flex justify-end space-x-3 shrink-0">
               <button onClick={() => setIsSettingsOpen(false)} className="px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-200 rounded-lg transition">
                キャンセル
              </button>
              <button onClick={saveSettings} className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition shadow-sm">
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
