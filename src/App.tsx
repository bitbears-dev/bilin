import { useState, useEffect } from "react";
import { Play, Plus, Settings, X, Globe, ChevronRight, Loader2, Volume2, CheckCircle2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import OpenAI from "openai";
import { get, set } from "idb-keyval";
import "./App.css";

interface Paragraph {
  id: string;
  originalText: string;
  translatedText: string | null;
  isLoading: boolean;
  isAudioLoading: boolean;
  isPlaying: boolean;
  isCached?: boolean;
}

interface Session {
  id: string;
  url: string;
  title: string;
  paragraphs: Paragraph[];
  iframeUrl: string;
  isFetching: boolean;
}

function App() {
  const [apiKey, setApiKey] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempKey, setTempKey] = useState("");

  const [sessions, setSessions] = useState<Session[]>([{
    id: "default", url: "", title: "", paragraphs: [], iframeUrl: "", isFetching: false,
  }]);
  const [activeSessionId, setActiveSessionId] = useState<string>("default");

  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const key = localStorage.getItem("open_ai_api_key");
    if (key) setApiKey(key);

    // ロード時に保存されたセッション状態を復元する
    get("bilin_sessions").then((saved) => {
      if (saved && Array.isArray(saved) && saved.length > 0) {
        // UIの状態(ロード状況など)は初期値にリセットしてから復元する
        const resetSaved = saved.map(s => ({
            ...s,
            isFetching: false,
            paragraphs: s.paragraphs.map((p: any) => ({
                ...p, isLoading: false, isAudioLoading: false, isPlaying: false 
            }))
        }));
        setSessions(resetSaved);
        setActiveSessionId(resetSaved[0].id);
      }
      setIsLoaded(true);
    });
  }, []);

  // sessions配列に変更があるたびにローカルDBに保存
  useEffect(() => {
    if (isLoaded) {
      set("bilin_sessions", sessions).catch(console.warn);
    }
  }, [sessions, isLoaded]);

  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0];

  const updateActiveSession = (updates: Partial<Session>) => {
    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, ...updates } : s));
  };

  const saveApiKey = () => {
    localStorage.setItem("open_ai_api_key", tempKey);
    setApiKey(tempKey);
    setIsSettingsOpen(false);
  };

  const handleAddNewSession = () => {
    const newId = Date.now().toString();
    setSessions(prev => [...prev, {
      id: newId, url: "", title: "", paragraphs: [], iframeUrl: "", isFetching: false
    }]);
    setActiveSessionId(newId);
  };

  const handleCloseSession = (idToClose: string, e: React.MouseEvent) => {
    // タブクリックイベント(setActiveSessionId)が同時に発火するのを防ぐ
    e.stopPropagation();
    
    setSessions(prev => {
      const filtered = prev.filter(s => s.id !== idToClose);
      
      // すべてのタブを閉じた場合、新規の空タブを作成
      if (filtered.length === 0) {
        const newId = Date.now().toString();
        setActiveSessionId(newId);
        return [{ id: newId, url: "", title: "", paragraphs: [], iframeUrl: "", isFetching: false }];
      }
      
      // アクティブなタブを閉じた場合は、リストの最後にあるタブをアクティブにする
      if (idToClose === activeSessionId) {
        setActiveSessionId(filtered[filtered.length - 1].id);
      }
      
      return filtered;
    });
  };

  const loadArticle = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!activeSession.url) return;

    updateActiveSession({ isFetching: true, paragraphs: [], iframeUrl: "", title: "" });
    
    try {
      const html: string = await invoke("fetch_html", { url: activeSession.url });
      
      const parser = new DOMParser();
      const cleanHtml = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
      const doc = parser.parseFromString(cleanHtml, "text/html");
      const reader = new Readability(doc);
      const article = reader.parse();

      if (article && article.content) {
        const pageTitle = article.title || "Untitled Article";
        
        const contentDoc = parser.parseFromString(article.content, "text/html");
        const elements = Array.from(contentDoc.querySelectorAll('p, h1, h2, h3, h4, li, blockquote'));
        
        const extracted: Paragraph[] = [];
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
              isCached: false,
            });
          }
        });
        
        updateActiveSession({ title: pageTitle, paragraphs: [...extracted], iframeUrl: activeSession.url });

        // 背景でキャッシュされた翻訳をチェック
        extracted.forEach(async (p) => {
          try {
            const cacheKey = `trans_${p.originalText}`;
            const cachedTranslation = await get(cacheKey);
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

  const handleTranslate = async (index: number) => {
    if (!apiKey) {
      window.alert("APIキーが設定されていません。左の歯車アイコンから設定してください。");
      return;
    }

    const p = activeSession.paragraphs[index];
    if (p.translatedText || p.isLoading) return;

    setSessions(prev => prev.map(s => s.id === activeSessionId ? {
      ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isLoading: true } : pr)
    } : s));

    try {
      const openai = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a professional translator. Translate the following English text to Japanese accurately, naturally, and contextually. Do not output anything other than the translated text." },
          { role: "user", content: p.originalText }
        ],
      });

      const translated = response.choices[0]?.message?.content || "（翻訳に失敗しました）";
      
      try {
        await set(`trans_${p.originalText}`, translated);
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
    if (!apiKey) {
      window.alert("APIキーが設定されていません。");
      return;
    }

    const p = activeSession.paragraphs[index];
    if (p.isAudioLoading || p.isPlaying) return;

    setSessions(prev => prev.map(s => s.id === activeSessionId ? {
      ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isAudioLoading: true } : pr)
    } : s));

    try {
      let cachedData: any = await get(`audio_${p.originalText}`);
      let blob: Blob;

      if (!cachedData || (!(cachedData instanceof Blob) && !(cachedData instanceof ArrayBuffer) && !(cachedData instanceof Uint8Array))) {
        const openai = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
        const mp3 = await openai.audio.speech.create({
          model: "tts-1",
          voice: "alloy",
          input: p.originalText,
        });

        const buffer = await mp3.arrayBuffer();
        blob = new Blob([buffer], { type: "audio/mpeg" });
        try {
          await set(`audio_${p.originalText}`, blob);
        } catch (e) {}
      } else {
        blob = cachedData instanceof Blob ? cachedData : new Blob([cachedData as BlobPart], { type: "audio/mpeg" });
      }

      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);

      audio.onended = () => {
        setSessions(prev => prev.map(s => s.id === activeSessionId ? {
          ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isPlaying: false } : pr)
        } : s));
        URL.revokeObjectURL(audioUrl);
      };

      await audio.play();
      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isPlaying: true, isAudioLoading: false } : pr)
      } : s));

    } catch (err: any) {
      window.alert("音声の生成中にエラーが発生しました: " + err.message);
      setSessions(prev => prev.map(s => s.id === activeSessionId ? {
        ...s, paragraphs: s.paragraphs.map((pr, i) => i === index ? { ...pr, isAudioLoading: false, isPlaying: false } : pr)
      } : s));
    }
  };

  if (!isLoaded) return null;

  return (
    <div className="flex h-screen w-screen bg-neutral-50 text-neutral-900 overflow-hidden font-sans">
      {/* 垂直タブ (左ペイン) */}
      <aside className="w-60 flex-shrink-0 bg-white border-r border-neutral-200 flex flex-col py-4 z-20 shadow-sm relative overflow-y-hidden">
        <div className="px-4 mb-5 flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold shadow-md shrink-0">Bi</div>
          <span className="font-bold text-neutral-800 tracking-wide text-lg">BiLin</span>
        </div>

        <div className="flex-1 px-3 space-y-2 overflow-y-auto">
          {sessions.map((s, idx) => {
            const isActive = s.id === activeSessionId;
            let domain = "";
            try { if (s.url) domain = new URL(s.url).hostname; } catch(e) {}
            const faviconUrl = domain ? `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(domain)}` : "";
            
            return (
              <div 
                key={s.id}
                onClick={() => setActiveSessionId(s.id)}
                className={`group w-full h-10 rounded-xl flex items-center px-3 cursor-pointer transition
                  ${isActive ? 'bg-blue-50 border border-blue-100 text-blue-700 shadow-sm' : 'bg-transparent text-neutral-600 border border-transparent hover:bg-neutral-100 hover:text-neutral-900'}`}
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
            onClick={() => { setTempKey(apiKey); setIsSettingsOpen(true); }}
            className={`w-full h-10 rounded-xl hover:bg-neutral-100 flex items-center px-3 cursor-pointer transition text-sm font-medium ${!apiKey ? 'text-red-500' : 'text-neutral-600'}`}
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
            {activeSession.iframeUrl ? (
              <iframe 
                src={activeSession.iframeUrl} 
                className="w-full h-full border-none"
                sandbox="allow-scripts allow-same-origin"
                title="Original Content"
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
            <span>Reading & Translation (Tab {sessions.findIndex(s => s.id === activeSessionId) + 1})</span>
            {!apiKey && (
              <span className="bg-red-100 text-red-600 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide">
                API Key Required
              </span>
            )}
          </span>
          <span className="text-xs text-neutral-400 font-medium">{activeSession.paragraphs.length} paragraphs</span>
        </div>
        
        <div className="flex-1 overflow-y-auto p-5 py-6 space-y-6">
          {activeSession.paragraphs.length === 0 && !activeSession.isFetching && (
            <div className="h-full flex flex-col items-center justify-center text-neutral-400 text-sm text-center px-8 border-2 border-dashed border-neutral-200/50 rounded-2xl mx-2">
              左側でURLを入力するか、セッションを選択してください
            </div>
          )}

          {activeSession.paragraphs.map((p, i) => (
            <div key={p.id} className="bg-white rounded-2xl p-5 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.05)] border border-neutral-200/60 transition-all hover:shadow-md hover:border-blue-200 group relative overflow-hidden">
              {p.isPlaying && (
                <div className="absolute top-0 left-0 w-full h-1 bg-blue-500 animate-pulse" />
              )}
              <div className="flex items-center justify-between mb-3">
                 <span className="text-xs font-bold text-neutral-400">P{i + 1}</span>
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
                    onClick={() => handleTranslate(i)}
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
                  <button 
                    onClick={() => handleListen(i)}
                    disabled={p.isAudioLoading || p.isPlaying}
                    className={`flex items-center space-x-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition shadow-sm cursor-pointer border
                      ${p.isPlaying 
                        ? 'bg-blue-100 text-blue-700 border-blue-200' 
                        : 'bg-neutral-50 text-neutral-500 hover:text-blue-600 hover:bg-blue-50 border-neutral-100'}
                      disabled:opacity-50`}
                  >
                    {p.isAudioLoading ? (
                      <Loader2 size={15} className="animate-spin text-neutral-400" />
                    ) : p.isPlaying ? (
                      <Volume2 size={15} className="fill-current text-blue-600 animate-pulse" />
                    ) : (
                      <Play size={15} className="fill-current" />
                    )}
                    <span>{p.isAudioLoading ? "生成中..." : p.isPlaying ? "Playing" : "Listen"}</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* 設定モーダル */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="h-14 border-b border-neutral-100 flex items-center justify-between px-6 bg-neutral-50/50">
              <h2 className="font-semibold text-neutral-800 flex items-center space-x-2">
                <Settings size={18} className="text-neutral-500" />
                <span>設定</span>
              </h2>
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 transition"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">OpenAI API Key</label>
                <input 
                  type="password"
                  value={tempKey}
                  onChange={(e) => setTempKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-neutral-50 border border-neutral-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition font-mono"
                />
                <p className="text-xs text-neutral-500 mt-2 leading-relaxed">
                  APIキーはブラウザのローカルストレージにのみ保存され、外部サーバには送信されません。
                </p>
              </div>
            </div>
            <div className="bg-neutral-50 px-6 py-4 border-t border-neutral-100 flex justify-end space-x-3">
               <button onClick={() => setIsSettingsOpen(false)} className="px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-200 rounded-lg transition">
                キャンセル
              </button>
              <button onClick={saveApiKey} className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition shadow-sm">
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
