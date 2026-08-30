import React, { useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';

const META_KEY = 'mirat-style-v4-meta';
const PERMANENT_MEMORY_KEY = 'mirat-style-v4-permanent-memory';
const PRIVACY_MIGRATION_KEY = 'mirat-style-v4-privacy-migrated';
const GROUP_TARGET = '__all_group_participants__';
const DB_NAME = 'mirat-style-v4-db';
const DB_VERSION = 1;
const emptyProfile = {
  summary: '',
  styleFingerprint: [],
  patterns: [],
  phrases: [],
  signals: [],
  cautions: [],
  situations: [],
  examples: [],
};
const STOP = new Set(
  'من في على عن إلى الى و أو او أن ان هي هو هذا هذه ذلك ذاك مع ما لا لم لن لي لك لها له انا أنا انت أنت نحن هم كان كانت يكون تكون قد يا كل بس مو موش اكو شنو شلون ليش وين هذي هاي الذي التي'.split(
    /\s+/,
  ),
);

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export function parseWhatsApp(text) {
  const output = [];
  let current = null;
  let index = 0;
  const patterns = [
    /^\[?(\d{1,4}[\/\.\-]\d{1,2}[\/\.\-]\d{1,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|ص|م)?)\]?\s*[-–—:]\s*([^:]+):\s?(.*)$/iu,
    /^(\d{1,4}[\/\.\-]\d{1,2}[\/\.\-]\d{1,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|ص|م)?)\s*[-–—]\s*([^:]+):\s?(.*)$/iu,
  ];
  const ignored =
    /messages and calls are end-to-end encrypted|الرسائل والمكالمات محمية|media omitted|الوسائط مفقودة|<media omitted>|هذه الرسالة محذوفة|this message was deleted/i;

  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const match = patterns.map((pattern) => line.match(pattern)).find(Boolean);
    if (match) {
      const message = match[4].trim();
      current = {
        id: `m_${Date.now()}_${index++}_${Math.random().toString(36).slice(2)}`,
        date: match[1],
        time: match[2].trim(),
        speaker: match[3].trim(),
        text: message,
      };
      if (message && !ignored.test(message)) output.push(current);
    } else if (current && line.trim() && !ignored.test(line.trim())) {
      current.text += `\n${line.trim()}`;
    }
  }
  return output.filter((message) => message.text.trim());
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP.has(word));
}

function makeTerms(value) {
  return [...new Set(tokenize(value))];
}

function score(query, memory) {
  const queryTerms = makeTerms(query);
  if (!queryTerms.length) return 0;
  const text = [
    memory.title,
    memory.trigger,
    memory.context,
    memory.herMessage,
    memory.responsePattern,
    (memory.keywords || []).join(' '),
  ].join(' ');
  const terms = new Set(tokenize(text));
  let hit = 0;
  queryTerms.forEach((term) => {
    if (terms.has(term)) hit += 1;
  });
  const phrase = String(memory.herMessage || '').trim().toLowerCase();
  if (phrase.length > 8 && String(query).toLowerCase().includes(phrase)) hit += 5;
  return hit / (Math.sqrt(queryTerms.length) * Math.sqrt(Math.max(terms.size, 1))) * 10;
}

function retrieve(query, memories, messages, her, limit = 18) {
  const memoryMatches = memories
    .map((memory) => ({ ...memory, _score: score(query, memory) }))
    .filter((memory) => memory._score > 0);
  const messageMatches = messages
    .filter((message) => her === GROUP_TARGET || message.speaker === her)
    .map((message) => ({
      title: 'رسالة سابقة',
      category: 'رسالة مشابهة',
      context: message.text,
      herMessage: message.text,
      responsePattern: '',
      keywords: makeTerms(message.text),
      evidence: 'رسالة فعلية من الأرشيف',
      confidence: 50,
      _score: score(query, { context: message.text, herMessage: message.text }),
    }))
    .filter((memory) => memory._score > 0);
  return [...memoryMatches, ...messageMatches]
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

function sampleForProfile(messages, max = 18000) {
  if (messages.length <= max) return messages;
  const head = messages.slice(0, Math.min(4000, messages.length));
  const tail = messages.slice(-Math.min(6000, messages.length));
  const step = Math.max(
    1,
    Math.floor(messages.length / Math.max(1, max - head.length - tail.length)),
  );
  const middle = [];
  for (let i = 4000; i < messages.length - 6000; i += step) middle.push(messages[i]);
  return [...head, ...middle, ...tail].slice(0, max);
}

function makeWindows(messages, her, size = 40) {
  const output = [];
  for (let i = 0; i < messages.length; i += size) {
    const window = messages.slice(i, i + size);
    if (her === GROUP_TARGET || window.some((message) => message.speaker === her)) output.push(window);
  }
  return output;
}

function memoryKey(memory) {
  return [memory.category, memory.title, memory.herMessage, memory.context].join('|').toLowerCase();
}

function Card({ title, icon = '✦', children, wide = false }) {
  return (
    <section className={`card ${wide ? 'wide' : ''}`}>
      <div className="ct">
        <span aria-hidden="true">{icon}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function MirrorApp() {
  const [messages, setMessages] = useState([]);
  const [files, setFiles] = useState([]);
  const [her, setHer] = useState('');
  const [me, setMe] = useState('');
  const [profile, setProfile] = useState(emptyProfile);
  const [memories, setMemories] = useState([]);
  const [savedMemories, setSavedMemories] = useState([]);
  const [tab, setTab] = useState('chat');
  const [question, setQuestion] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState('');
  const fileRef = useRef();

  useEffect(() => {
    (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(PERMANENT_MEMORY_KEY) || '[]');
        setSavedMemories(Array.isArray(saved) ? saved : []);
        localStorage.removeItem(META_KEY);
        if (!localStorage.getItem(PRIVACY_MIGRATION_KEY)) {
          await dbClear();
          localStorage.setItem(PRIVACY_MIGRATION_KEY, '1');
        }
      } catch (error) {
        setNotice(`تعذر فتح الذاكرة المحلية: ${error.message}`);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(PERMANENT_MEMORY_KEY, JSON.stringify(savedMemories));
  }, [savedMemories, ready]);

  const names = useMemo(
    () => [...new Set(messages.map((message) => message.speaker))].sort((a, b) => a.localeCompare(b)),
    [messages],
  );
  const isGroupSelection = her === GROUP_TARGET;
  const herMessages = useMemo(
    () => messages.filter((message) => message.speaker === her),
    [messages, her],
  );
  const selectedMessages = useMemo(
    () => (isGroupSelection ? messages : herMessages),
    [isGroupSelection, messages, herMessages],
  );
  const targetName = isGroupSelection ? 'المجموعة' : her;
  const groupInsights = useMemo(() => {
    if (!isGroupSelection || !messages.length) return null;
    const counts = new Map(names.map((name) => [name, 0]));
    const pairCounts = new Map();
    let speakerChanges = 0;
    messages.forEach((message, index) => {
      counts.set(message.speaker, (counts.get(message.speaker) || 0) + 1);
      const previous = messages[index - 1]?.speaker;
      if (previous && previous !== message.speaker) {
        speakerChanges += 1;
        const pair = `${previous} → ${message.speaker}`;
        pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
      }
    });
    const participantRows = [...counts.entries()]
      .map(([name, count]) => ({
        name,
        count,
        share: Math.round((count / messages.length) * 100),
      }))
      .sort((a, b) => b.count - a.count);
    const interactionPairs = [...pairCounts.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return {
      participantRows,
      participantCount: names.length,
      messageCount: messages.length,
      turnCount: messages.length ? speakerChanges + 1 : 0,
      interactionPairs,
    };
  }, [isGroupSelection, messages, names]);
  const retrieved = useMemo(
    () => retrieve(question || chatInput, [...savedMemories, ...memories], messages, her, 18),
    [question, chatInput, savedMemories, memories, messages, her],
  );
  const allMemories = useMemo(
    () => [...savedMemories, ...memories],
    [savedMemories, memories],
  );
  const visibleMemory = useMemo(() => {
    const query = search.trim();
    return query
      ? allMemories
          .map((memory) => ({ ...memory, _score: score(query, memory) }))
          .filter((memory) => memory._score > 0)
          .sort((a, b) => b._score - a._score)
      : allMemories;
  }, [search, allMemories]);

  async function importFiles(list) {
    const textFiles = [...list].filter((file) => /\.txt$/i.test(file.name));
    if (!textFiles.length) {
      setNotice('ارفع ملف TXT من تصدير واتساب.');
      return;
    }
    setBusy(true);
    setNotice('جاري قراءة ملفات واتساب…');
    try {
      const existing = new Set(
        messages.map((message) => `${message.date}|${message.time}|${message.speaker}|${message.text}`),
      );
      const added = [];
      const newMeta = [];
      for (const file of textFiles) {
        const parsed = parseWhatsApp(await file.text());
        let unique = 0;
        parsed.forEach((message) => {
          const key = `${message.date}|${message.time}|${message.speaker}|${message.text}`;
          if (existing.has(key)) return;
          existing.add(key);
          added.push(message);
          unique += 1;
        });
        newMeta.push({ name: file.name, count: unique, addedAt: new Date().toISOString() });
      }
      setMessages((current) => [...current, ...added]);
      setFiles((previous) => [...previous, ...newMeta]);
      if (!her && added[0]) setHer(added[0].speaker);
      setNotice(`تمت إضافة ${added.length.toLocaleString('ar')} رسالة جديدة.`);
      setTab('data');
    } catch (error) {
      setNotice(`فشل استيراد المحادثة: ${error.message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function build() {
    if (!selectedMessages.length) {
      setNotice(isGroupSelection ? 'استورد محادثة المجموعة أولاً.' : 'اختر الشخص المراد تحليله أولاً.');
      setTab('data');
      return;
    }
    setBusy(true);
    setProgress(0);
      setNotice('جاري بناء تحليل مؤقت للجلسة…');
    try {
      const profileResponse = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ herName: targetName, messages: sampleForProfile(selectedMessages) }),
      });
      const profileData = await profileResponse.json();
      if (!profileResponse.ok) throw new Error(profileData.error || 'فشل البصمة');
      setProfile(profileData);

      const windows = makeWindows(messages, isGroupSelection ? GROUP_TARGET : her, 36);
      const selected =
        windows.length > 120
          ? windows.filter((_, index) => index % Math.ceil(windows.length / 120) === 0)
          : windows;
      const all = [];
      for (let index = 0; index < selected.length; index += 1) {
        const response = await fetch('/api/memory-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ herName: targetName, messages: selected[index] }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'فشل الذاكرة');
        all.push(...(data.memories || []));
        setProgress(Math.round(((index + 1) / selected.length) * 100));
      }
      const deduped = new Map();
      all.forEach((memory) => {
        const key = [memory.category, memory.title, memory.herMessage].join('|').toLowerCase();
        if (!deduped.has(key) || deduped.get(key).confidence < memory.confidence) {
          deduped.set(key, memory);
        }
      });
      setMemories([...deduped.values()].slice(0, 1200));
      setNotice(`اكتمل التحليل المؤقت: ${deduped.size.toLocaleString('ar')} قرينة. لم تُحفظ بالذاكرة الدائمة.`);
      setTab('profile');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  function saveMemory(memory) {
    setSavedMemories((current) => {
      const key = memoryKey(memory);
      if (current.some((item) => memoryKey(item) === key)) return current;
      return [...current, { ...memory }];
    });
    setMemories((current) => current.filter((item) => memoryKey(item) !== memoryKey(memory)));
    setNotice('تم حفظ هذا الموقف بالذاكرة الدائمة.');
  }

  function saveAllMemories() {
    if (!memories.length) return;
    setSavedMemories((current) => {
      const next = [...current];
      const keys = new Set(next.map(memoryKey));
      memories.forEach((memory) => {
        const key = memoryKey(memory);
        if (!keys.has(key)) {
          next.push({ ...memory });
          keys.add(key);
        }
      });
      return next;
    });
    setMemories([]);
    setNotice('تم حفظ نتائج الجلسة بالذاكرة الدائمة بناءً على طلبك.');
  }

  function clearPermanentMemory() {
    if (!window.confirm('سيتم حذف الذاكرة الدائمة المحفوظة فقط. هل أنت متأكد؟')) return;
    setSavedMemories([]);
    setNotice('تم مسح الذاكرة الدائمة. نتائج الجلسة المؤقتة لم تُحفظ.');
  }

  async function analyze() {
    if (!question.trim()) {
      setNotice('ألصق الموقف أولاً.');
      return;
    }
    setBusy(true);
    setAnalysis(null);
    setNotice('جاري مقارنة الموقف بالسياق السابق…');
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          herName: targetName,
          question,
          profile,
          memory: retrieved.slice(0, 30),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'فشل تحليل الموقف.');
      setAnalysis(data);
      setNotice('اكتمل التحليل.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendChat() {
    if (!chatInput.trim() || busy) return;
    const message = chatInput.trim();
    setChatInput('');
    const next = [...chat, { role: 'user', content: message }];
    setChat(next);
    setBusy(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          herName: targetName,
          profile,
          memory: retrieve(message, allMemories, messages, her, 18),
          chat: next,
          message,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'فشل الرد.');
      setChat((current) => [...current, { role: 'assistant', content: data.answer }]);
    } catch (error) {
      setChat((current) => [
        ...current,
        { role: 'assistant', content: `تعذر تنفيذ الطلب: ${error.message}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!window.confirm('سيتم حذف بيانات الجلسة والذاكرة الدائمة من هذا الجهاز. هل أنت متأكد؟')) {
      return;
    }
    await dbClear();
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(PERMANENT_MEMORY_KEY);
    setSavedMemories([]);
    setMessages([]);
    setFiles([]);
    setHer('');
    setMe('');
    setProfile(emptyProfile);
    setMemories([]);
    setChat([]);
    setQuestion('');
    setAnalysis(null);
    setNotice('تم مسح بيانات الجلسة والذاكرة الدائمة.');
  }

  function exportBackup() {
    const blob = new Blob(
      [JSON.stringify({ version: 5, files, her, me, profile, temporaryMemories: memories, savedMemories, chat, messages }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mirat-al-uslub-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.messages)) throw new Error('ملف النسخة الاحتياطية غير صالح');
      await dbClear();
      setMessages(data.messages);
      setFiles(data.files || []);
      setHer(data.her || '');
      setMe(data.me || '');
      setProfile(data.profile || emptyProfile);
      setMemories(data.temporaryMemories || data.memories || []);
      setSavedMemories(Array.isArray(data.savedMemories) ? data.savedMemories : []);
      setChat(data.chat || []);
      setNotice('تم استرجاع النسخة الاحتياطية إلى الجلسة. اضغط حفظ بالذاكرة لأي موقف تريد الاحتفاظ به دائماً.');
    } catch (error) {
      setNotice(`فشل الاسترجاع: ${error.message}`);
    }
  }

  if (!ready) return <div className="loading">جاري تجهيز الذاكرة المحلية…</div>;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="logo" aria-hidden="true">م</div>
          <div><b>مرآة الأسلوب</b><small>ذاكرة أسلوبية خاصة</small></div>
        </div>
        <div className="head-actions">
          <button onClick={() => fileRef.current?.click()}>＋ واتساب</button>
          <button className="ghost" onClick={exportBackup}>نسخة احتياطية</button>
          <button className="ghost" onClick={clearAll}>مسح</button>
        </div>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".txt,text/plain"
          multiple
          onChange={(event) => importFiles(event.target.files)}
          aria-label="استيراد ملفات واتساب"
        />
      </header>

      <main>
        <div className="hero">
          <div>
            <span className="eyebrow">يتعلم من السياق الحقيقي، لا من التخمين</span>
            <h1>مو بس يفسّر رسالة.<br /><em>يتذكر السياق أيضاً.</em></h1>
            <p>ارفع محادثات واتساب لتحليلها مؤقتاً. التطبيق يبني بصمة للجلسة، ثم يسترجع المواقف الأقرب قبل كل تحليل دون حفظ تلقائي.</p>
          </div>
          <div className="orb" aria-hidden="true">✦</div>
        </div>

        <nav aria-label="أقسام مرآة الأسلوب">
          {[
            ['chat', 'المحادثة'],
            ['analyze', 'تحليل موقف'],
            ['profile', 'البصمة'],
            ['memory', <>الذاكرة <i>{savedMemories.length}</i></>],
            ['data', 'البيانات'],
          ].map(([value, label]) => (
            <button key={value} className={tab === value ? 'on' : ''} onClick={() => setTab(value)}>
              {label}
            </button>
          ))}
        </nav>

        {notice && <div className="notice" role="status">{busy ? '◌ ' : ''}{notice}{busy && progress ? ` ${progress}%` : ''}</div>}

        {tab === 'chat' && (
          <div className="chat-wrap">
            <div className="chatbox">
              <div className="chat-head">
                <div><b>مساعد مرآة الأسلوب</b><small>{her ? `مرجع: ${targetName}` : 'أضف محادثة وحدد الشخص أولاً'}</small></div>
                <span>●</span>
              </div>
              <div className="messages">
                {chat.length === 0 ? (
                  <div className="welcome">
                    <div className="welcome-icon" aria-hidden="true">✦</div>
                    <h2>شلون أساعدك؟</h2>
                    <p>اسألني عن رد، موقف، أو طريقة مناسبة للرد.</p>
                    <div className="quick">
                      <button onClick={() => setChatInput('شنو أكثر الأشياء اللي تميز أسلوب كلام الشخص؟')}>حلل الأسلوب</button>
                      <button onClick={() => setChatInput('هل يبدو الشخص منزعجاً من هذا الرد؟ وما الأدلة؟')}>هل يبدو منزعجاً؟</button>
                      <button onClick={() => setChatInput('شنو أفضل رد طبيعي على هذا الموقف؟')}>شنو أرد؟</button>
                    </div>
                  </div>
                ) : chat.map((item, index) => <div key={index} className={`bubble ${item.role}`}>{item.content}</div>)}
                {busy && <div className="bubble assistant typing">جاري التفكير…</div>}
              </div>
              <div className="composer">
                <textarea
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      sendChat();
                    }
                  }}
                  placeholder="اكتب سؤالك…"
                  aria-label="رسالة المساعد"
                />
                <button onClick={sendChat} disabled={busy} aria-label="إرسال">➤</button>
              </div>
            </div>
          </div>
        )}

        {tab === 'analyze' && (
          <div className="two">
            <Card title="الموقف الجديد" icon="⌁">
               <textarea className="bigtext" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={'الصق المحادثة هنا…\nأنا: ...\nالشخص: ...'} aria-label="الموقف الجديد" />
               <button className="primary" onClick={analyze} disabled={busy || !question.trim()}>حلّل مقارنةً بالسياق السابق ✦</button>
              {retrieved.length > 0 && <div className="retrieval"><small>استرجاع محلي: {retrieved.length} قرائن مرتبطة.</small>{retrieved.slice(0, 5).map((memory, index) => <span key={index}>{memory.title}</span>)}</div>}
            </Card>
            {analysis && (
              <div className="result">
                <Card title="القراءة الأقرب" icon="◎">
                  <div className="state"><b>{analysis.likelyState || 'غير محسوم'}</b><span>{Math.round(analysis.confidence || 0)}% ثقة</span></div>
                  <p className="biganswer">{analysis.interpretation}</p>
                  <div className="uncertainty">{analysis.uncertainty}</div>
                </Card>
                <Card title="الأدلة والأنماط المشابهة" icon="⌕"><ul>{[...(analysis.evidence || []), ...(analysis.similarPatterns || [])].map((item, index) => <li key={index}>{item}</li>)}</ul></Card>
                <Card title="احتمالات أخرى وردود مقترحة" icon="◇">
                  <ul>{(analysis.alternatives || []).map((item, index) => <li key={index}>{item}</li>)}</ul>
                  <div className="reply-list">{(analysis.suggestedResponses || []).map((item, index) => <div key={index}><b>رد {index + 1}:</b> {item}</div>)}</div>
                  <div className="avoid">{(analysis.whatNotToDo || []).map((item, index) => <span key={index}>تجنب: {item}</span>)}</div>
                </Card>
              </div>
            )}
          </div>
        )}

        {tab === 'profile' && (
          <div className="profile">
             <Card title="الخلاصة المؤقتة" icon="✦" wide><p className="summary">{profile.summary || 'لم يُبنَ التحليل بعد. اذهب إلى البيانات ثم اضغط تحليل مؤقت.'}</p><div className="chips">{(profile.styleFingerprint || []).map((item, index) => <span key={index}>{item}</span>)}</div><p className="muted">هذه البصمة تخص الجلسة الحالية فقط ولا تُحفظ في الذاكرة الدائمة تلقائياً.</p></Card>
            <Card title="الأنماط المتكررة" icon="↻"><ul>{(profile.patterns || []).map((item, index) => <li key={index}>{item}</li>)}</ul></Card>
            <Card title="العبارات والسياقات" icon="❝"><ul>{(profile.phrases || []).map((item, index) => <li key={index}>{item}</li>)}</ul></Card>
             <Card title="المواقف حسب السياق" icon="⌘"><ul>{(profile.situations || []).map((item, index) => <li key={index}>{item}</li>)}</ul></Card>
            <Card title="إشارات وحدود التحليل" icon="⚑"><ul>{[...(profile.signals || []), ...(profile.cautions || [])].map((item, index) => <li key={index}>{item}</li>)}</ul></Card>
          </div>
        )}

        {tab === 'memory' && (
          <div className="memory-page">
             <Card title="الذاكرة الأسلوبية" icon="⌘" wide>
              <div className="stats">
                 <div><b>{messages.length.toLocaleString('ar')}</b><span>رسالة مؤقتة للجلسة</span></div>
                  <div><b>{selectedMessages.length.toLocaleString('ar')}</b><span>{isGroupSelection ? 'رسالة في المجموعة' : 'رسالة للشخص المحدد'}</span></div>
                 <div><b>{savedMemories.length.toLocaleString('ar')}</b><span>موقف محفوظ دائماً</span></div>
                 <div><b>{memories.length.toLocaleString('ar')}</b><span>قرينة مؤقتة للجلسة</span></div>
              </div>
              <input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث داخل الذاكرة…" aria-label="البحث داخل الذاكرة" />
               <p className="muted">المحادثة والبصمة والقرائن المستخرجة مؤقتة للجلسة. لا تُضاف الذاكرة الدائمة إلا بعد ضغط «حفظ بالذاكرة» صراحةً.</p>
               <div className="memory-actions">
                 {memories.length > 0 && <button className="primary compact" onClick={saveAllMemories}>حفظ نتائج الجلسة بالذاكرة</button>}
                 <button className="danger" onClick={clearPermanentMemory} disabled={!savedMemories.length}>مسح الذاكرة الدائمة</button>
               </div>
            </Card>
             <div className="memory-grid">{visibleMemory.slice(0, 160).map((memory, index) => {
               const isSaved = savedMemories.some((item) => memoryKey(item) === memoryKey(memory));
               return <Card key={index} title={memory.title || 'موقف'} icon="•"><span className={`cat ${isSaved ? 'saved' : 'temporary'}`}>{isSaved ? 'محفوظ دائماً' : 'مؤقت للجلسة'}</span><p>{memory.context}</p>{memory.herMessage && <blockquote>«{memory.herMessage}»</blockquote>}<small>{memory.responsePattern}</small>{!isSaved && <button className="save-memory" onClick={() => saveMemory(memory)}>حفظ بالذاكرة</button>}</Card>;
             })}</div>
          </div>
        )}

        {tab === 'data' && (
          <div className="two">
            <Card title="محادثات واتساب" icon="▣">
               <div className="drop" onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && fileRef.current?.click()}><b>＋ أضف ملفات TXT</b><small>يدعم عدة ملفات ويزيل الرسائل المكررة. كل البيانات مؤقتة للجلسة.</small></div>
              {files.map((file, index) => <div className="file" key={index}><span>{file.name}</span><small>{Number(file.count || 0).toLocaleString('ar')} رسالة</small></div>)}
            </Card>
            <Card title="إعداد المشاركين والتحليل المؤقت" icon="♙">
              <label>{isGroupSelection ? 'المحادثة المراد تحليلها' : 'الشخص المراد تحليله'}<select value={her} onChange={(event) => setHer(event.target.value)}><option value="">اختر الاسم</option>{names.length > 1 && <option value={GROUP_TARGET}>كل المشاركين (المجموعة)</option>}{names.map((name) => <option key={name}>{name}</option>)}</select></label>
              <label>اسمك<input value={me} onChange={(event) => setMe(event.target.value)} placeholder="اختياري" /></label>
              <button className="primary" onClick={build} disabled={busy || !selectedMessages.length}>حلّل مؤقتاً للجلسة</button>
              <div className="privacy">المحادثات والبصمة والقرائن المستخرجة تبقى مؤقتة داخل هذه الجلسة ولا تُحفظ تلقائياً. اختر «حفظ بالذاكرة» فقط للمواقف التي تريد الاحتفاظ بها دائماً.</div>
              {memories.length > 0 && <button className="save-memory save-all" onClick={saveAllMemories}>حفظ نتائج الجلسة بالذاكرة</button>}
              <button className="danger" onClick={clearPermanentMemory} disabled={!savedMemories.length}>مسح الذاكرة الدائمة</button>
              <hr />
              <label className="backup">استرجاع نسخة احتياطية<input type="file" accept="application/json,.json" onChange={(event) => event.target.files[0] && importBackup(event.target.files[0])} /></label>
            </Card>
            {isGroupSelection && groupInsights && (
              <Card title="تفاعل المجموعة" icon="◌">
                <div className="stats">
                  <div><b>{groupInsights.participantCount.toLocaleString('ar')}</b><span>مشاركون مكتشفون</span></div>
                  <div><b>{groupInsights.messageCount.toLocaleString('ar')}</b><span>رسالة في المجموعة</span></div>
                  <div><b>{groupInsights.turnCount.toLocaleString('ar')}</b><span>تبادل أدوار</span></div>
                </div>
                <ul>
                  {groupInsights.participantRows.map((item) => <li key={item.name}>{item.name}: {item.count.toLocaleString('ar')} رسالة ({item.share}٪)</li>)}
                  {groupInsights.interactionPairs.length > 0 && <li>أكثر مسارات التفاعل تكراراً: {groupInsights.interactionPairs.map((item) => `${item.pair} (${item.count})`).join('، ')}</li>}
                </ul>
              </Card>
            )}
          </div>
        )}
      </main>
      <footer>مرآة الأسلوب لا تدّعي معرفة النوايا الداخلية. هي تقارن اللغة والسياق السابق وتعرض الاحتمال مع أدلته وحدوده. كلما كانت المحادثات أكثر تنوعاً، صار الاسترجاع أدق.</footer>
    </div>
  );
}

export default MirrorApp;