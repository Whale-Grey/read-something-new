import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, FileText, HelpCircle, Trophy, Plus, Trash2, Loader2, ChevronLeft, Check, X } from 'lucide-react';
import twemoji from '@twemoji/api';
const twemojiParse = twemoji.parse.bind(twemoji);
import {
  Book, FavoriteQuote, Achievement, QuizSession, Notebook, StudyNote, QuizQuestion, ApiConfig, ReaderHighlightRange,
} from '../types';
import { getBookContent } from '../utils/bookContentStorage';
import { Character, Persona } from './settings/types';
import { buildConversationKey, readConversationBucket, ChatBubble, CHAT_STORE_UPDATED_EVENT } from '../utils/readerChatRuntime';
import {
  getAllNotebooks, getAllFavoriteQuotes, getAllAchievements, getAllQuizSessions,
  saveNotebook, saveQuizSession, deleteAchievement, deleteFavoriteQuote,
} from '../utils/studyHubStorage';
import { prepareBookContexts, buildQuizGenerationPrompt, parseQuizQuestions } from '../utils/studyHubAiEngine';
import { callAiModel } from '../utils/readerAiEngine';
import ResolvedImage from './ResolvedImage';

// ─── TwemojiIcon ─────────────────────────────────────────────────────────────

const TwemojiIcon: React.FC<{ emoji: string; size?: number }> = ({ emoji, size = 32 }) => {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = emoji;
    twemojiParse(ref.current, { folder: 'svg', ext: '.svg' });
  }, [emoji]);
  return (
    <span
      ref={ref}
      className="twemoji-icon"
      style={{ display: 'inline-block', width: size, height: size, lineHeight: 1, flexShrink: 0 }}
    />
  );
};

// ─── Types ───────────────────────────────────────────────────────────────────

type TabKey = '对话' | '笔记' | '问答' | '印章';
type QuizView = 'list' | 'create' | 'play' | 'result';

interface RecentBookPanelProps {
  recentBook: Book;
  books: Book[];
  activeCharacterId: string | null;
  activePersonaId: string | null;
  characters: Character[];
  personas: Persona[];
  isDarkMode: boolean;
  apiConfig: ApiConfig;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const stripChatContent = (raw: string): string =>
  raw
    .replace(/\[气泡\]([\s\S]*?)\[\/气泡\]/g, '$1')
    .replace(/\[划线\]([\s\S]*?)\[\/划线\]/g, '$1')
    .replace(/【成就[：:][^】]*】/g, '')
    .trim();

const formatDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const stripMarkdown = (s: string) =>
  s
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim();

// ─── Component ────────────────────────────────────────────────────────────────

const RecentBookPanel: React.FC<RecentBookPanelProps> = ({
  recentBook,
  books,
  activeCharacterId,
  activePersonaId,
  characters,
  personas,
  isDarkMode,
  apiConfig,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('对话');

  // 颜色类
  const bg = isDarkMode ? 'bg-[#2d3748]' : 'bg-[#F3F3F3]';
  const cardBg = isDarkMode ? 'bg-[#374151]' : 'bg-white';
  const pressedBg = isDarkMode ? 'bg-[#232b39]' : 'bg-[#e8e8e8]';
  const text = isDarkMode ? 'text-slate-200' : 'text-[#1A1A1A]';
  const subText = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const borderCol = isDarkMode ? 'border-slate-600' : 'border-slate-200';

  const activeChar = characters.find((c) => c.id === activeCharacterId) || null;

  // ─── 对话 ─────────────────────────────────────────────────────────────────

  const [chatMessages, setChatMessages] = useState<ChatBubble[]>([]);

  const loadChat = useCallback(() => {
    const key = buildConversationKey(recentBook.id, activePersonaId, activeCharacterId);
    const bucket = readConversationBucket(key);
    setChatMessages(bucket.messages.slice(-15));
  }, [recentBook.id, activePersonaId, activeCharacterId]);

  useEffect(() => {
    loadChat();
  }, [loadChat]);

  // 监听对话更新事件
  useEffect(() => {
    const handler = () => loadChat();
    window.addEventListener(CHAT_STORE_UPDATED_EVENT, handler);
    return () => window.removeEventListener(CHAT_STORE_UPDATED_EVENT, handler);
  }, [loadChat]);

  // ─── 笔记 ─────────────────────────────────────────────────────────────────

  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [quotes, setQuotes] = useState<FavoriteQuote[]>([]);
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [bookHighlights, setBookHighlights] = useState<Array<{ chapterKey: string; start: number; end: number; text: string; color: string }>>([]);
  const [editingHighlightNoteId, setEditingHighlightNoteId] = useState<string | null>(null);
  const [editingHighlightNoteText, setEditingHighlightNoteText] = useState('');

  const loadNotes = useCallback(async () => {
    const [nbs, qs, bookContent] = await Promise.all([
      getAllNotebooks(),
      getAllFavoriteQuotes(),
      getBookContent(recentBook.id),
    ]);
    setNotebooks(nbs.filter((nb) => nb.boundBookIds.includes(recentBook.id)));
    setQuotes(qs.filter((q) => q.bookId === recentBook.id));

    // Extract highlight ranges with text
    const highlightsByChapter = bookContent?.readerState?.highlightsByChapter || {};
    const fullText = bookContent?.fullText || '';
    const chapters = bookContent?.chapters || [];

    const highlights: Array<{ chapterKey: string; start: number; end: number; text: string; color: string }> = [];
    for (const [chapterKey, ranges] of Object.entries(highlightsByChapter)) {
      const chapterText = chapterKey === 'full'
        ? fullText
        : (() => {
            const idx = parseInt(chapterKey.replace('chapter-', ''), 10);
            return chapters[idx]?.content || '';
          })();
      for (const range of (ranges as ReaderHighlightRange[])) {
        const text = chapterText.slice(range.start, range.end).trim();
        if (text) {
          highlights.push({ chapterKey, start: range.start, end: range.end, text, color: range.color });
        }
      }
    }
    setBookHighlights(highlights);
  }, [recentBook.id]);

  const handleSaveNote = async () => {
    if (!noteText.trim()) return;
    setNoteSaving(true);
    try {
      // 找到绑定了该书的第一个笔记本，没有则创建
      let targetNb = notebooks[0];
      if (!targetNb) {
        targetNb = {
          id: `nb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: recentBook.title,
          personaId: activePersonaId || '',
          boundBookIds: [recentBook.id],
          notes: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      const newNote: StudyNote = {
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: noteText.trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        commentThreads: [],
      };
      const updated: Notebook = {
        ...targetNb,
        notes: [...targetNb.notes, newNote],
        updatedAt: Date.now(),
      };
      await saveNotebook(updated);
      setNoteText('');
      setIsAddingNote(false);
      await loadNotes();
    } finally {
      setNoteSaving(false);
    }
  };

  const handleDeleteQuote = async (id: string) => {
    await deleteFavoriteQuote(id);
    setQuotes((prev) => prev.filter((q) => q.id !== id));
  };

  // ─── 问答 ─────────────────────────────────────────────────────────────────

  const [quizSessions, setQuizSessions] = useState<QuizSession[]>([]);
  const [quizView, setQuizView] = useState<QuizView>('list');
  const [activeSession, setActiveSession] = useState<QuizSession | null>(null);
  const [currentQIdx, setCurrentQIdx] = useState(0);
  const [playAnswers, setPlayAnswers] = useState<Record<string, number[]>>({});
  const [isGenerating, setIsGenerating] = useState(false);
  const [qCount, setQCount] = useState(5);
  const [qType, setQType] = useState<'single' | 'multiple' | 'truefalse'>('single');
  const abortRef = useRef<AbortController | null>(null);

  const loadQuiz = useCallback(async () => {
    const ss = await getAllQuizSessions();
    setQuizSessions(ss.filter((s) => s.config.bookIds.includes(recentBook.id)));
  }, [recentBook.id]);

  const handleCreateQuiz = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    abortRef.current = new AbortController();
    try {
      const bookContexts = await prepareBookContexts([recentBook], [recentBook.id], 800, true);
      const config = {
        bookIds: [recentBook.id],
        questionCount: qCount,
        questionType: qType,
        optionCount: qType === 'truefalse' ? 2 : 4,
        customPrompt: '',
      };
      const prompt = buildQuizGenerationPrompt({ bookContexts, config, ragContextByBookId: {} });
      const raw = await callAiModel(prompt, apiConfig, abortRef.current.signal);
      const questions = parseQuizQuestions(raw);
      if (questions.length === 0) throw new Error('未能生成题目，请重试');

      const session: QuizSession = {
        id: `quiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        config,
        questions,
        userAnswers: {},
        characterId: activeCharacterId || '',
        characterName: activeChar?.name || '',
        overallComment: '',
        createdAt: Date.now(),
      };
      await saveQuizSession(session);
      await loadQuiz();
      setActiveSession(session);
      setPlayAnswers({});
      setCurrentQIdx(0);
      setQuizView('play');
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        alert('生成失败：' + (e instanceof Error ? e.message : String(e)));
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSelectAnswer = (qId: string, idx: number) => {
    setPlayAnswers((prev) => {
      const cur = prev[qId] || [];
      const q = activeSession?.questions.find((q) => q.id === qId);
      if (!q) return prev;
      if (q.type === 'single' || q.type === 'truefalse') {
        return { ...prev, [qId]: [idx] };
      }
      // multiple
      if (cur.includes(idx)) return { ...prev, [qId]: cur.filter((i) => i !== idx) };
      return { ...prev, [qId]: [...cur, idx] };
    });
  };

  const handleFinishQuiz = async () => {
    if (!activeSession) return;
    const updated: QuizSession = {
      ...activeSession,
      userAnswers: playAnswers,
      completedAt: Date.now(),
    };
    await saveQuizSession(updated);
    setActiveSession(updated);
    await loadQuiz();
    setQuizView('result');
  };

  const handleDeleteQuiz = async (id: string) => {
    const { deleteQuizSession } = await import('../utils/studyHubStorage');
    await deleteQuizSession(id);
    setQuizSessions((prev) => prev.filter((s) => s.id !== id));
  };

  // ─── 印章 ─────────────────────────────────────────────────────────────────

  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [longPressAchId, setLongPressAchId] = useState<string | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAchievements = useCallback(async () => {
    const all = await getAllAchievements();
    setAchievements(all.filter((a) => a.bookId === recentBook.id));
  }, [recentBook.id]);

  const handleDeleteAchievement = async (id: string) => {
    await deleteAchievement(id);
    setAchievements((prev) => prev.filter((a) => a.id !== id));
  };

  // ─── Tab切换时加载数据 ────────────────────────────────────────────────────

  useEffect(() => {
    if (activeTab === '笔记') loadNotes();
    if (activeTab === '问答') { loadQuiz(); setQuizView('list'); }
    if (activeTab === '印章') loadAchievements();
  }, [activeTab, loadNotes, loadQuiz, loadAchievements]);

  // ─── Tab Bar ──────────────────────────────────────────────────────────────

  const tabs: { key: TabKey; icon: React.ReactNode; label: string }[] = [
    { key: '对话', icon: <MessageSquare size={14} />, label: '对话' },
    { key: '笔记', icon: <FileText size={14} />, label: '笔记' },
    { key: '问答', icon: <HelpCircle size={14} />, label: '问答' },
    { key: '印章', icon: <Trophy size={14} />, label: '印章' },
  ];

  const tabIdx = tabs.findIndex((t) => t.key === activeTab);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={`overflow-hidden ${isDarkMode ? 'bg-[#2d3748]' : 'bg-[#F3F3F3]'}`}>

      {/* Tab bar */}
      <div className={`relative grid grid-cols-4 p-1 ${pressedBg}`}>
        {/* slider */}
        <div
          className={`absolute top-1 bottom-1 rounded-xl transition-transform duration-200 ${isDarkMode ? 'bg-[#2d3748]' : 'bg-[#F3F3F3]'}`}
          style={{ width: 'calc((100% - 0.5rem) / 4)', transform: `translateX(calc(${tabIdx} * 100%))` }}
        />
        {tabs.map(({ key, icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`relative z-10 flex items-center justify-center gap-1 py-2 rounded-xl text-xs font-bold transition-colors ${
              activeTab === key ? text : subText
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="overflow-y-auto">

        {/* ─── 对话 ──────────────────────────────────────────────────────── */}
        {activeTab === '对话' && (
          <div className="p-4 flex flex-col gap-3">
            {chatMessages.length === 0 ? (
              <div className={`text-center py-8 text-sm ${subText}`}>暂无对话记录</div>
            ) : (
              chatMessages.map((msg) => {
                const isUser = msg.sender === 'user';
                const content = stripChatContent(msg.content);
                if (!content) return null;
                return (
                  <div key={msg.id} className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                    {/* AI avatar */}
                    {!isUser && (
                      <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-slate-200 flex items-center justify-center">
                        {activeChar?.avatar
                          ? <ResolvedImage src={activeChar.avatar} className="w-full h-full object-cover" alt="" />
                          : <span className="text-[10px] text-slate-500">{activeChar?.name?.[0] || 'A'}</span>
                        }
                      </div>
                    )}
                    <div
                      className={`max-w-[78%] px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                        isUser
                          ? isDarkMode ? 'bg-slate-600 text-slate-100' : 'bg-[#1A1A1A] text-white'
                          : isDarkMode ? 'bg-[#374151] text-slate-200' : 'bg-white text-[#1A1A1A]'
                      }`}
                      style={{ border: isUser ? 'none' : '1px solid #e5e7eb' }}
                    >
                      {content}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ─── 笔记 ──────────────────────────────────────────────────────── */}
        {activeTab === '笔记' && (
          <div className="p-4 flex flex-col gap-3">
            {/* 新建笔记 */}
            {isAddingNote ? (
              <div className={`rounded-2xl p-3 flex flex-col gap-2 ${cardBg}`}
                style={{ border: `1px solid ${isDarkMode ? '#4b5563' : '#e5e7eb'}` }}>
                <textarea
                  autoFocus
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="写下你的笔记..."
                  rows={4}
                  className={`w-full text-sm outline-none resize-none bg-transparent ${text}`}
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => { setIsAddingNote(false); setNoteText(''); }}
                    className={`px-3 py-1 rounded-full text-xs ${subText}`}>
                    取消
                  </button>
                  <button onClick={handleSaveNote} disabled={noteSaving || !noteText.trim()}
                    className="px-3 py-1 rounded-full text-xs font-bold bg-[#1A1A1A] text-white disabled:opacity-40 flex items-center gap-1">
                    {noteSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setIsAddingNote(true)}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold border-2 border-dashed transition-colors w-fit ${
                  isDarkMode ? 'border-slate-600 text-slate-400 hover:border-slate-400' : 'border-slate-300 text-slate-400 hover:border-slate-500'
                }`}>
                <Plus size={14} /> 新建笔记
              </button>
            )}

            {/* 划线 */}
            {(() => {
              const highlightNotesList = notebooks.flatMap(nb =>
                nb.notes.filter(n => n.highlightRef).map(n => ({ note: n, nb }))
              );
              const rawHighlights = bookHighlights.filter(h =>
                !highlightNotesList.some(hn =>
                  hn.note.highlightRef?.chapterKey === h.chapterKey &&
                  hn.note.highlightRef?.start === h.start &&
                  hn.note.highlightRef?.end === h.end
                )
              );

              if (highlightNotesList.length === 0 && rawHighlights.length === 0) return null;

              return (
                <>
                  <div className={`text-xs font-bold uppercase tracking-wider ${subText} mt-2`}>划线</div>

                  {/* Highlights with notes */}
                  {highlightNotesList.map(({ note, nb }) => (
                    <div key={note.id} className={`rounded-2xl p-3 ${cardBg}`}
                      style={{ border: `1px solid ${isDarkMode ? '#4b5563' : '#e5e7eb'}` }}>
                      {/* Highlighted text */}
                      <div className="text-xs px-2 py-1 rounded mb-2"
                        style={{ backgroundColor: '#fef08a33', borderLeft: '3px solid #fef08a' }}>
                        <p className={`text-xs line-clamp-2 ${subText}`}>"{note.highlightRef!.text}"</p>
                      </div>
                      {/* Note content */}
                      {editingHighlightNoteId === note.id ? (
                        <div className="flex flex-col gap-2">
                          <textarea
                            autoFocus
                            value={editingHighlightNoteText}
                            onChange={(e) => setEditingHighlightNoteText(e.target.value)}
                            rows={3}
                            className={`w-full text-sm outline-none resize-none bg-transparent ${text}`}
                          />
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setEditingHighlightNoteId(null)}
                              className={`px-3 py-1 rounded-full text-xs ${subText}`}>取消</button>
                            <button onClick={async () => {
                              const updated = { ...nb, notes: nb.notes.map(n2 => n2.id === note.id ? { ...n2, content: editingHighlightNoteText, updatedAt: Date.now() } : n2), updatedAt: Date.now() };
                              await saveNotebook(updated);
                              setEditingHighlightNoteId(null);
                              await loadNotes();
                            }} className="px-3 py-1 rounded-full text-xs font-bold bg-[#1A1A1A] text-white">保存</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className={`text-sm ${text}`}>{note.content}</p>
                          <div className="flex items-center justify-between mt-2">
                            <span className={`text-[10px] ${subText}`}>{formatDate(note.updatedAt)}</span>
                            <div className="flex gap-2">
                              <button onClick={() => { setEditingHighlightNoteId(note.id); setEditingHighlightNoteText(note.content); }}
                                className={`text-xs ${subText} hover:text-slate-600`}>编辑</button>
                              <button onClick={async () => {
                                const updated = { ...nb, notes: nb.notes.filter(n2 => n2.id !== note.id), updatedAt: Date.now() };
                                await saveNotebook(updated);
                                await loadNotes();
                              }} className="text-slate-300 hover:text-rose-400 transition-colors">
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ))}

                  {/* Raw highlights (no note) */}
                  {rawHighlights.map((h) => (
                    <div key={`${h.chapterKey}-${h.start}`} className={`rounded-2xl p-3 ${cardBg}`}
                      style={{ border: `1px solid ${isDarkMode ? '#4b5563' : '#e5e7eb'}` }}>
                      <div className="px-2 py-1 rounded"
                        style={{ backgroundColor: h.color ? `${h.color}33` : '#fef08a33', borderLeft: `3px solid ${h.color || '#fef08a'}` }}>
                        <p className={`text-xs line-clamp-3 ${subText}`}>"{h.text}"</p>
                      </div>
                    </div>
                  ))}
                </>
              );
            })()}

            {/* 摘录 */}
            {quotes.length > 0 && (
              <>
                <div className={`text-xs font-bold uppercase tracking-wider ${subText} mt-2`}>摘录</div>
                {quotes.map((q) => (
                  <div key={q.id} className={`relative rounded-2xl p-3 ${cardBg}`}
                    style={{ border: `1px solid ${isDarkMode ? '#4b5563' : '#e5e7eb'}` }}>
                    <p className={`text-sm line-clamp-3 ${text}`}>"{q.content}"</p>
                    <div className="flex items-center justify-between mt-2">
                      <span className={`text-[10px] ${subText}`}>{q.senderName} · {formatDate(q.createdAt)}</span>
                      <button onClick={() => handleDeleteQuote(q.id)} className="text-slate-300 hover:text-rose-400 transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* 笔记 */}
            {notebooks.flatMap((nb) => nb.notes.filter(n => !n.highlightRef)).length > 0 && (
              <>
                <div className={`text-xs font-bold uppercase tracking-wider ${subText} mt-2`}>笔记</div>
                {notebooks.flatMap((nb) => nb.notes.filter(n => !n.highlightRef).map((n) => ({ note: n, nb }))).map(({ note, nb }) => (
                  <div key={note.id} className={`rounded-2xl p-3 ${cardBg}`}
                    style={{ border: `1px solid ${isDarkMode ? '#4b5563' : '#e5e7eb'}` }}>
                    <p className={`text-sm line-clamp-3 ${text}`} style={{ fontFamily: '"Noto Serif SC", serif' }}>
                      {stripMarkdown(note.content) || '空白笔记'}
                    </p>
                    <div className={`text-[10px] mt-2 ${subText}`}>{nb.title} · {formatDate(note.updatedAt)}</div>
                  </div>
                ))}
              </>
            )}

            {quotes.length === 0 && notebooks.flatMap((nb) => nb.notes).length === 0 && bookHighlights.length === 0 && !isAddingNote && (
              <div className={`text-center py-6 text-sm ${subText}`}>暂无笔记或摘录</div>
            )}
          </div>
        )}

        {/* ─── 问答 ──────────────────────────────────────────────────────── */}
        {activeTab === '问答' && (
          <>
            {/* 列表视图 */}
            {quizView === 'list' && (
              <div className="p-4 flex flex-col gap-3">
                {/* 创建按钮 */}
                <div className={`rounded-2xl p-4 flex flex-col gap-3 ${pressedBg}`}>
                  <div className={`text-xs font-bold ${subText} uppercase tracking-wider`}>创建新问答</div>
                  <div className="flex gap-3 items-center flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${subText}`}>题数</span>
                      {[3, 5, 10].map((n) => (
                        <button key={n} onClick={() => setQCount(n)}
                          className={`w-8 h-8 rounded-full text-xs font-bold transition-colors ${qCount === n ? 'bg-[#1A1A1A] text-white' : `${cardBg} ${subText} border ${borderCol}`}`}>
                          {n}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${subText}`}>类型</span>
                      {([['single', '单选'], ['multiple', '多选'], ['truefalse', '判断']] as [typeof qType, string][]).map(([k, label]) => (
                        <button key={k} onClick={() => setQType(k)}
                          className={`px-2 h-8 rounded-full text-xs font-bold transition-colors ${qType === k ? 'bg-[#1A1A1A] text-white' : `${cardBg} ${subText} border ${borderCol}`}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button onClick={handleCreateQuiz} disabled={isGenerating}
                    className="flex items-center justify-center gap-2 py-2 rounded-full text-sm font-bold bg-[#1A1A1A] text-white disabled:opacity-50">
                    {isGenerating ? <><Loader2 size={14} className="animate-spin" />生成中…</> : <><Plus size={14} />生成问答</>}
                  </button>
                </div>

                {/* 历史列表 */}
                {quizSessions.length > 0 && (
                  <>
                    <div className={`text-xs font-bold uppercase tracking-wider ${subText}`}>历史记录</div>
                    {quizSessions.map((s) => {
                      const isIncomplete = !s.completedAt;
                      const total = s.questions.length;
                      let correct = 0;
                      s.questions.forEach((q) => {
                        const ans = s.userAnswers[q.id] || [];
                        if (ans.length === q.correctAnswerIndices.length && ans.every((a) => q.correctAnswerIndices.includes(a))) correct++;
                      });
                      const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
                      const answered = s.questions.filter((q) => (s.userAnswers[q.id]?.length || 0) > 0).length;

                      return (
                        <div key={s.id}
                          onClick={() => {
                            setActiveSession(s);
                            if (isIncomplete) {
                              setPlayAnswers(s.userAnswers);
                              setCurrentQIdx(s.questions.findIndex((q) => !(s.userAnswers[q.id]?.length)));
                              setQuizView('play');
                            } else {
                              setQuizView('result');
                            }
                          }}
                          className={`relative rounded-2xl p-4 cursor-pointer transition-colors ${cardBg}`}
                          style={{ border: `1px solid ${isDarkMode ? '#4b5563' : '#e5e7eb'}` }}>
                          <div className="flex items-start justify-between">
                            <div>
                              <div className={`text-sm font-bold ${text}`}>
                                {total} 题 · {s.config.questionType === 'single' ? '单选' : s.config.questionType === 'multiple' ? '多选' : '判断'}
                              </div>
                              <div className={`text-xs mt-1 ${subText}`}>
                                {isIncomplete ? `进行中 ${answered}/${total}` : `正确率 ${pct}%`}
                              </div>
                              <div className={`text-[10px] mt-1 ${subText}`}>{formatDate(s.createdAt)}</div>
                            </div>
                            <div className={`text-2xl font-black ${isIncomplete ? subText : pct >= 60 ? 'text-emerald-500' : 'text-rose-400'}`}>
                              {isIncomplete ? `${answered}/${total}` : `${pct}%`}
                            </div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteQuiz(s.id); }}
                            className={`absolute bottom-3 right-3 opacity-30 hover:opacity-100 transition-opacity ${subText}`}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {/* 答题视图 */}
            {quizView === 'play' && activeSession && (() => {
              const q = activeSession.questions[currentQIdx];
              const selectedAnswers = playAnswers[q?.id] || [];
              const isLast = currentQIdx >= activeSession.questions.length - 1;

              return (
                <div className="p-4 flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setQuizView('list')} className={`${subText} hover:${text}`}>
                      <ChevronLeft size={18} />
                    </button>
                    <span className={`text-xs font-bold ${subText}`}>
                      {currentQIdx + 1} / {activeSession.questions.length}
                    </span>
                  </div>

                  <div className={`text-sm font-bold leading-relaxed ${text}`}>{q?.question}</div>
                  <div className="flex flex-col gap-2">
                    {q?.options.map((opt, i) => {
                      const isSelected = selectedAnswers.includes(i);
                      return (
                        <button key={i} onClick={() => handleSelectAnswer(q.id, i)}
                          className={`text-left px-4 py-3 rounded-xl text-sm transition-colors ${
                            isSelected
                              ? 'bg-[#1A1A1A] text-white'
                              : `${cardBg} ${text} border ${borderCol} hover:border-slate-400`
                          }`}>
                          <span className="font-bold mr-2">{String.fromCharCode(65 + i)}.</span>{opt}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex gap-2 justify-end">
                    {currentQIdx > 0 && (
                      <button onClick={() => setCurrentQIdx((i) => i - 1)}
                        className={`px-4 py-2 rounded-full text-xs font-bold border ${borderCol} ${subText}`}>
                        上一题
                      </button>
                    )}
                    {!isLast ? (
                      <button onClick={() => setCurrentQIdx((i) => i + 1)}
                        disabled={selectedAnswers.length === 0}
                        className="px-4 py-2 rounded-full text-xs font-bold bg-[#1A1A1A] text-white disabled:opacity-40">
                        下一题
                      </button>
                    ) : (
                      <button onClick={handleFinishQuiz}
                        disabled={selectedAnswers.length === 0}
                        className="px-4 py-2 rounded-full text-xs font-bold bg-[#1A1A1A] text-white disabled:opacity-40">
                        提交
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* 结果视图 */}
            {quizView === 'result' && activeSession && (() => {
              let correct = 0;
              activeSession.questions.forEach((q) => {
                const ans = activeSession.userAnswers[q.id] || [];
                if (ans.length === q.correctAnswerIndices.length && ans.every((a) => q.correctAnswerIndices.includes(a))) correct++;
              });
              const total = activeSession.questions.length;
              const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

              return (
                <div className="p-4 flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setQuizView('list')} className={`${subText}`}>
                      <ChevronLeft size={18} />
                    </button>
                    <span className={`text-xs font-bold ${subText}`}>答题结果</span>
                  </div>

                  <div className="text-center py-2">
                    <div className={`text-4xl font-black ${pct >= 60 ? 'text-emerald-500' : 'text-rose-400'}`}>{pct}%</div>
                    <div className={`text-xs mt-1 ${subText}`}>{correct} / {total} 题正确</div>
                  </div>

                  {activeSession.questions.map((q, idx) => {
                    const userAns = activeSession.userAnswers[q.id] || [];
                    const isCorrect = userAns.length === q.correctAnswerIndices.length && userAns.every((a) => q.correctAnswerIndices.includes(a));
                    return (
                      <div key={q.id} className={`rounded-2xl p-4 ${cardBg}`}
                        style={{ border: `2px solid ${isCorrect ? '#10b981' : '#f87171'}` }}>
                        <div className="flex items-start gap-2 mb-3">
                          {isCorrect
                            ? <Check size={14} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                            : <X size={14} className="text-rose-400 flex-shrink-0 mt-0.5" />
                          }
                          <span className={`text-sm font-bold ${text}`}>{idx + 1}. {q.question}</span>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {q.options.map((opt, i) => {
                            const isUserSelected = userAns.includes(i);
                            const isCorrectOpt = q.correctAnswerIndices.includes(i);
                            return (
                              <div key={i} className={`px-3 py-2 rounded-xl text-xs ${
                                isCorrectOpt
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : isUserSelected
                                  ? 'bg-rose-50 text-rose-600 border border-rose-200'
                                  : isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-50 text-slate-500'
                              }`}>
                                <span className="font-bold mr-1">{String.fromCharCode(65 + i)}.</span>{opt}
                                {isCorrectOpt && <span className="ml-1 font-bold">✓</span>}
                                {isUserSelected && !isCorrectOpt && <span className="ml-1 font-bold">✗</span>}
                              </div>
                            );
                          })}
                        </div>
                        {q.explanation && (
                          <div className={`mt-3 pt-2 border-t ${borderCol} text-xs ${subText} leading-relaxed`}>
                            {q.explanation}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </>
        )}

        {/* ─── 印章 ──────────────────────────────────────────────────────── */}
        {activeTab === '印章' && (
          <div className="p-4 flex flex-col gap-3">
            {achievements.length === 0 ? (
              <div className={`text-center py-8 text-sm ${subText}`}>暂无成就印章</div>
            ) : (
              achievements.map((ach) => (
                <div
                  key={ach.id}
                  className="relative rounded-2xl overflow-hidden select-none"
                  style={{
                    backgroundColor: '#262928',
                    backgroundImage: 'radial-gradient(circle, #333736 1.5px, transparent 1.5px)',
                    backgroundSize: '10px 10px',
                    padding: '16px 14px 12px',
                  }}
                  onPointerDown={() => {
                    longPressTimerRef.current = setTimeout(() => setLongPressAchId(ach.id), 600);
                  }}
                  onPointerUp={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } }}
                  onPointerCancel={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } }}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  {/* 图标 + 名称 */}
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <TwemojiIcon emoji={ach.icon} size={32} />
                    <span style={{ fontSize: '22px', fontWeight: 900, color: '#A5ABAA', lineHeight: 1.2, letterSpacing: '1px', WebkitTextStroke: '6px #1e2120', paintOrder: 'stroke fill' }}>{ach.name}</span>
                  </div>
                  {/* 条件 */}
                  <div style={{ fontSize: '11px', color: 'rgba(165,171,170,0.9)', marginBottom: '8px', lineHeight: 1.5 }}>
                    <span style={{ opacity: 0.5 }}>条件 </span>{ach.condition}
                  </div>
                  {/* 评价 */}
                  {ach.comment && (
                    <div style={{ fontSize: '11px', fontStyle: 'italic', color: 'rgba(165,171,170,0.7)', borderTop: '1px solid rgba(165,171,170,0.15)', paddingTop: '8px', marginBottom: '6px' }}>
                      "{ach.comment}"
                    </div>
                  )}
                  {/* 来源 — 右下角 */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', fontSize: '10px', opacity: 0.4, color: '#A5ABAA', marginTop: '4px' }}>
                    {ach.characterName}{ach.bookTitle ? ` · ${ach.bookTitle}` : ''} · {formatDate(ach.createdAt)}
                  </div>

                  {/* 长按删除弹窗 */}
                  {longPressAchId === ach.id && (
                    <div
                      className="absolute inset-0 flex items-center justify-center rounded-2xl"
                      style={{ backgroundColor: 'rgba(30,33,32,0.85)', backdropFilter: 'blur(2px)' }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => { handleDeleteAchievement(ach.id); setLongPressAchId(null); }}
                        className="flex flex-col items-center gap-1 text-rose-400 active:opacity-60 transition-opacity"
                      >
                        <Trash2 size={22} />
                        <span style={{ fontSize: '11px' }}>删除</span>
                      </button>
                      <button
                        onClick={() => setLongPressAchId(null)}
                        className="absolute top-2 right-3 text-slate-400 active:opacity-60"
                        style={{ fontSize: '18px', lineHeight: 1 }}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default RecentBookPanel;
