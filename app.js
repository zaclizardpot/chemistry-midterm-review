(() => {
  'use strict';

  const STORAGE_KEY = 'chemistry-midterm-review-v1';
  const DATA_VERSION = '20261019-1';
  const BANK_META = {
    exam: {
      label: '考古原題',
      description: '考古題保留原題幹、選項與順序；詳解與核對結果以中文呈現。'
    },
    practice: {
      label: '統整練習',
      description: '依老師投影片、筆記漏項與高頻考點編寫；目前全數為單選題，不含非選題。'
    }
  };
  const TYPE_LABEL = { single: '單選', multiple: '多選', short_answer: '非選' };
  const banks = { exam: [], practice: [] };
  let state = loadState();
  let currentQuestion = null;
  let answerRevealed = false;
  let supabaseClient = null;
  let currentUser = null;
  let remoteTimer = null;

  const $ = selector => document.querySelector(selector);
  const card = $('#question-card');
  const historyDialog = $('#history-dialog');
  const accountDialog = $('#account-dialog');

  function defaultState() {
    return {
      version: 1,
      activeBank: 'exam',
      mode: 'general',
      progress: { exam: {}, practice: {} },
      sessions: {
        exam: { generalQueue: [], generalIndex: 0, starQueue: [], starIndex: 0 },
        practice: { generalQueue: [], generalIndex: 0, starQueue: [], starIndex: 0 }
      },
      updatedAt: 0
    };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return parsed && parsed.version === 1 ? parsed : defaultState();
    } catch (_) {
      return defaultState();
    }
  }

  function ensureStateShape() {
    const fallback = defaultState();
    state.activeBank = BANK_META[state.activeBank] ? state.activeBank : 'exam';
    state.mode = state.mode === 'star' ? 'star' : 'general';
    state.progress ||= fallback.progress;
    state.sessions ||= fallback.sessions;
    Object.keys(BANK_META).forEach(bankName => {
      state.progress[bankName] ||= {};
      state.sessions[bankName] ||= fallback.sessions[bankName];
      const valid = new Set(banks[bankName].map(question => question.id));
      const session = state.sessions[bankName];
      session.generalQueue = (session.generalQueue || []).filter(id => valid.has(id));
      session.starQueue = (session.starQueue || []).filter(id => valid.has(id));
      session.generalIndex = Number.isFinite(session.generalIndex) ? session.generalIndex : 0;
      session.starIndex = Number.isFinite(session.starIndex) ? session.starIndex : 0;
    });
  }

  function saveState() {
    state.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $('#sync-status').textContent = currentUser ? '已儲存在本機，正在同步…' : '進度已儲存在這台裝置';
    scheduleRemoteSave();
  }

  function scheduleRemoteSave() {
    if (!supabaseClient || !currentUser) return;
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(saveRemote, 550);
  }

  async function saveRemote() {
    if (!supabaseClient || !currentUser) return;
    const { error } = await supabaseClient.from('chemistry_study_progress').upsert({
      user_id: currentUser.id,
      state,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    $('#sync-status').textContent = error ? `雲端同步失敗：${error.message}` : '進度已同步到雲端';
    $('#sync-dot').classList.toggle('online', !error);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function normalizeAnswer(value) {
    return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function normalizeQuestion(raw, bankName) {
    const options = (raw.options || []).map((option, index) => typeof option === 'string'
      ? { id: String.fromCharCode(65 + index), text: option }
      : { id: String(option.id ?? String.fromCharCode(65 + index)), text: String(option.text ?? '') });
    const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
    const sourceParts = [];
    if (source.file) sourceParts.push(source.file);
    if (source.question !== null && source.question !== undefined) sourceParts.push(`Q${source.question}`);
    if (source.page) sourceParts.push(`p.${source.page}`);
    return {
      ...raw,
      bank: bankName,
      type: raw.type === 'free' ? 'short_answer' : raw.type,
      options,
      correctAnswers: (raw.correctAnswers || raw.answer || []).map(String),
      chapter: raw.chapter || raw.ch || 'General',
      topics: Array.isArray(raw.topics) ? raw.topics : [],
      assets: Array.isArray(raw.assets) ? raw.assets : [],
      sourceInfo: source,
      sourceLabel: sourceParts.join('｜') || String(raw.source || ''),
      explanation: raw.explanation || raw.explain || raw.answerText || '',
      incomplete: raw.status === 'source_incomplete' || raw.excludeFromScoring === true
    };
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  function progressFor(bankName = state.activeBank, id = currentQuestion?.id) {
    if (!id) return {};
    return state.progress[bankName][id] ||= {
      attempts: 0, missed: 0, starred: false, lastCorrect: null, lastAnswer: null, updatedAt: 0
    };
  }

  function refreshQueue(bankName = state.activeBank, mode = state.mode) {
    const session = state.sessions[bankName];
    if (mode === 'star') {
      session.starQueue = shuffle(banks[bankName].filter(question => progressFor(bankName, question.id).starred).map(question => question.id));
      session.starIndex = 0;
    } else {
      session.generalQueue = shuffle(banks[bankName].filter(question => !progressFor(bankName, question.id).starred).map(question => question.id));
      session.generalIndex = 0;
    }
    saveState();
  }

  function currentQueueInfo() {
    const session = state.sessions[state.activeBank];
    return state.mode === 'star'
      ? { queue: session.starQueue, indexKey: 'starIndex' }
      : { queue: session.generalQueue, indexKey: 'generalIndex' };
  }

  function getNextQuestion(advance = false) {
    const session = state.sessions[state.activeBank];
    let { queue, indexKey } = currentQueueInfo();
    if (!queue.length) {
      refreshQueue(state.activeBank, state.mode);
      ({ queue, indexKey } = currentQueueInfo());
    }
    if (!queue.length) return null;
    if (advance) session[indexKey] += 1;
    const eligible = id => state.mode === 'star'
      ? progressFor(state.activeBank, id).starred
      : !progressFor(state.activeBank, id).starred;
    let guard = 0;
    while (guard < queue.length && !eligible(queue[session[indexKey] % queue.length])) {
      session[indexKey] += 1;
      guard += 1;
    }
    if (guard >= queue.length) {
      refreshQueue(state.activeBank, state.mode);
      ({ queue, indexKey } = currentQueueInfo());
      if (!queue.length) return null;
    }
    session[indexKey] %= queue.length;
    return banks[state.activeBank].find(question => question.id === queue[session[indexKey]]) || null;
  }

  function instructionFor(question) {
    if (question.incomplete) return '原始考卷的必要內容不完整；本題保留供核對，不計分。';
    return {
      single: 'Choose the best answer.',
      multiple: 'Select all correct answers.',
      short_answer: '先自行作答，再查看參考答案與詳解。'
    }[question.type] || '';
  }

  function renderAssets(question) {
    if (!question.assets.length) return '';
    return `<div class="question-assets">${question.assets.map((asset, index) => {
      const path = typeof asset === 'string' ? asset : (asset.path || asset.src || '');
      const alt = typeof asset === 'object' && asset.alt ? asset.alt : `${question.id} 附圖 ${index + 1}`;
      return path ? `<img src="${escapeHtml(path)}" alt="${escapeHtml(alt)}" loading="lazy">` : '';
    }).join('')}</div>`;
  }

  function renderInputs(question) {
    if (question.incomplete) return `<div class="source-warning">${escapeHtml(question.sourceInfo.notes || '原檔缺少必要附圖、選項或可核對答案，因此不進行自動評分。')}</div>`;
    if (question.type === 'single' || question.type === 'multiple') {
      const inputType = question.type === 'single' ? 'radio' : 'checkbox';
      return `<div class="options">${question.options.map(option => `
        <label class="option"><input type="${inputType}" name="answer" value="${escapeHtml(option.id)}"><span>${escapeHtml(option.id)}. ${escapeHtml(option.text)}</span></label>`).join('')}</div>`;
    }
    if (question.type === 'short_answer') {
      return '<textarea id="short-answer" class="answer-input" placeholder="先在這裡整理你的作答，再查看參考答案。"></textarea>';
    }
    return '<div class="source-warning">這筆題目的題型尚未支援，請在題目總覽中核對內容。</div>';
  }

  function renderQuestion(question) {
    currentQuestion = question;
    answerRevealed = false;
    updateHeader();
    if (!question) {
      const message = state.mode === 'star' ? '目前沒有星號題目。你可以回到一般題庫，按題卡上的 ☆ 加入。' : '這個題庫目前沒有可練習的題目。';
      card.innerHTML = `<div class="empty-state"><div><h2>${message}</h2><p class="subtitle">可使用上方按鈕切換題庫或刷新。</p></div></div>`;
      return;
    }
    const progress = progressFor();
    const { queue, indexKey } = currentQueueInfo();
    const position = queue.length ? (state.sessions[state.activeBank][indexKey] % queue.length) + 1 : 0;
    const topic = question.topics.length ? question.topics.join('／') : '';
    card.innerHTML = `
      <div class="meta-row">
        <span class="badge">${escapeHtml(question.chapter)}</span>
        <span class="badge">${escapeHtml(TYPE_LABEL[question.type] || question.type)}</span>
        ${question.incomplete ? '<span class="badge warning">來源不完整</span>' : ''}
        <span>${escapeHtml(question.sourceLabel)}</span>
        ${topic ? `<span>${escapeHtml(topic)}</span>` : ''}
      </div>
      <h2>${escapeHtml(question.prompt)}</h2>
      <p class="instruction">${escapeHtml(instructionFor(question))}</p>
      ${renderAssets(question)}
      <div id="answer-area">${renderInputs(question)}</div>
      <div id="result-area"></div>
      <div class="card-footer">
        <span>題目 ${position} / ${queue.length}</span>
        <div class="card-actions">
          <button id="card-star-button" class="button star-button ${progress.starred ? 'active' : ''}" type="button" aria-label="${progress.starred ? '取消星號' : '加入星號'}">${progress.starred ? '★' : '☆'}</button>
          <button id="check-button" class="button primary" type="button">${question.incomplete ? '查看缺漏說明' : question.type === 'short_answer' ? '查看參考答案' : '檢查答案'}</button>
        </div>
      </div>`;
    $('#card-star-button').addEventListener('click', toggleCurrentStar);
    $('#check-button').addEventListener('click', checkAnswer);
  }

  function collectAnswer(question) {
    if (question.type === 'single' || question.type === 'multiple') {
      return [...card.querySelectorAll('input[name="answer"]:checked')].map(input => input.value).sort();
    }
    if (question.type === 'short_answer') return $('#short-answer')?.value || '';
    return null;
  }

  function grade(question, response) {
    if (question.incomplete || question.type === 'short_answer') return null;
    if (question.type === 'single' || question.type === 'multiple') {
      const expected = [...question.correctAnswers].sort();
      return expected.length === response.length && expected.every((value, index) => value === response[index]);
    }
    return null;
  }

  function answerText(question) {
    if (question.answerText) return question.answerText;
    if (question.type === 'single' || question.type === 'multiple') {
      return question.correctAnswers.map(id => {
        const option = question.options.find(item => item.id === id);
        return `${id}. ${option?.text || ''}`;
      }).join('；');
    }
    return '原考卷未提供可辨識的參考答案；請以老師投影片核對。';
  }

  function checkAnswer() {
    if (!currentQuestion || answerRevealed) return;
    const response = collectAnswer(currentQuestion);
    if (!currentQuestion.incomplete && (currentQuestion.type === 'single' || currentQuestion.type === 'multiple') && !response.length) {
      alert('請先選擇答案。');
      return;
    }
    const correct = grade(currentQuestion, response);
    const progress = progressFor();
    progress.attempts += 1;
    progress.lastCorrect = correct;
    progress.lastAnswer = response;
    progress.updatedAt = Date.now();
    if (correct === false) {
      progress.missed += 1;
      progress.starred = true;
    }
    answerRevealed = true;
    saveState();
    renderResult(correct);
    updateHeader();
  }

  function renderResult(correct) {
    const progress = progressFor();
    const statusClass = correct === true ? 'correct' : correct === false ? 'incorrect' : currentQuestion.incomplete ? 'warning' : '';
    const statusText = currentQuestion.incomplete ? '此題來源資料不完整，不計分' : correct === true ? '答對了' : correct === false ? '答錯了，已自動加入星號' : '請核對參考答案';
    const source = currentQuestion.sourceInfo;
    const discrepancy = source.answerDiscrepancy
      ? `<p class="discrepancy"><strong>答案核對：</strong>原卷標記為 ${escapeHtml(source.sourceAnswer ?? '—')}；依化學內容驗證後採用 ${escapeHtml(source.verifiedAnswer ?? currentQuestion.correctAnswers.join(', '))} 作為評分答案。</p>`
      : '';
    $('#result-area').innerHTML = `<div class="result ${statusClass}">
      <h3>${statusText}</h3>
      <p>${escapeHtml(currentQuestion.explanation || source.notes || '請用老師投影片核對此題的判斷依據。')}</p>
      ${discrepancy}
      <p class="answer-line"><strong>參考答案：</strong>${escapeHtml(answerText(currentQuestion))}</p>
    </div>`;
    const actions = card.querySelector('.card-actions');
    actions.innerHTML = `
      <button id="card-star-button" class="button ${progress.starred ? 'star-button active' : 'ghost'}" type="button">${progress.starred ? '取消星號' : '加入星號'}</button>
      <button id="next-button" class="button primary" type="button">下一題</button>`;
    $('#card-star-button').addEventListener('click', () => {
      toggleCurrentStar();
      renderResult(correct);
    });
    $('#next-button').addEventListener('click', nextQuestion);
  }

  function toggleCurrentStar() {
    if (!currentQuestion) return;
    const progress = progressFor();
    progress.starred = !progress.starred;
    progress.updatedAt = Date.now();
    saveState();
    const button = $('#card-star-button');
    if (button && !answerRevealed) {
      button.classList.toggle('active', progress.starred);
      button.textContent = progress.starred ? '★' : '☆';
      button.setAttribute('aria-label', progress.starred ? '取消星號' : '加入星號');
    }
    updateHeader();
  }

  function nextQuestion() {
    saveState();
    renderQuestion(getNextQuestion(true));
  }

  function statsFor(bankName) {
    const records = Object.values(state.progress[bankName]);
    return {
      seen: records.filter(record => record.attempts > 0).length,
      correct: records.filter(record => record.lastCorrect === true).length,
      starred: records.filter(record => record.starred).length,
      missed: records.reduce((sum, record) => sum + (record.missed || 0), 0)
    };
  }

  function updateHeader() {
    const stats = statsFor(state.activeBank);
    $('#stat-seen').textContent = stats.seen;
    $('#stat-correct').textContent = stats.correct;
    $('#stat-starred').textContent = stats.starred;
    $('#stat-missed').textContent = stats.missed;
    $('#star-count').textContent = `(${stats.starred})`;
    $('#bank-description').textContent = BANK_META[state.activeBank].description;
    $('#mode-banner').classList.toggle('hidden', state.mode !== 'star');
    $('#mode-banner').textContent = state.mode === 'star' ? `★ 正在練習「${BANK_META[state.activeBank].label}」的星號題目；取消星號後，本題會退出此模式。` : '';
    const total = banks[state.activeBank].length || 1;
    $('#progress-bar').style.width = `${Math.min(100, stats.seen / total * 100)}%`;
    document.querySelectorAll('.bank-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.bank === state.activeBank));
  }

  function switchBank(bankName) {
    if (!BANK_META[bankName] || bankName === state.activeBank) return;
    state.activeBank = bankName;
    state.mode = 'general';
    saveState();
    renderQuestion(getNextQuestion(false));
  }

  function enterStarMode() {
    state.mode = state.mode === 'star' ? 'general' : 'star';
    if (state.mode === 'star') refreshQueue(state.activeBank, 'star');
    saveState();
    renderQuestion(getNextQuestion(false));
  }

  function renderHistory() {
    const query = normalizeAnswer($('#history-search').value);
    const filter = $('#history-filter').value;
    const items = banks[state.activeBank].filter(question => {
      const progress = progressFor(state.activeBank, question.id);
      const haystack = normalizeAnswer(`${question.prompt} ${question.answerText || ''} ${question.sourceLabel} ${question.chapter} ${question.topics.join(' ')}`);
      if (query && !haystack.includes(query)) return false;
      if (filter === 'seen' && !progress.attempts) return false;
      if (filter === 'unseen' && progress.attempts) return false;
      if (filter === 'starred' && !progress.starred) return false;
      if (filter === 'missed' && !progress.missed) return false;
      if (filter === 'incomplete' && !question.incomplete) return false;
      return true;
    });
    $('#history-list').innerHTML = items.map((question, index) => {
      const progress = progressFor(state.activeBank, question.id);
      const status = question.incomplete ? '來源不完整' : progress.attempts
        ? (progress.lastCorrect === true ? '最近答對' : progress.lastCorrect === false ? '最近答錯' : '已核對')
        : '未作答';
      return `<details class="history-item">
        <summary>
          <button class="history-star button ghost" data-id="${escapeHtml(question.id)}" type="button">${progress.starred ? '★' : '☆'}</button>
          <div class="history-badges"><span>#${index + 1}</span><span>${escapeHtml(question.chapter)}</span><span>${escapeHtml(TYPE_LABEL[question.type] || question.type)}</span><span>${escapeHtml(question.sourceLabel)}</span><span>${status}</span><span>答錯 ${progress.missed || 0} 次</span></div>
          <div class="history-title">${escapeHtml(question.prompt)}</div>
        </summary>
        <div class="history-body"><p><strong>答案：</strong>${escapeHtml(answerText(question))}</p><p><strong>詳解：</strong>${escapeHtml(question.explanation || question.sourceInfo.notes || '—')}</p></div>
      </details>`;
    }).join('') || '<p class="subtitle">沒有符合條件的題目。</p>';
    document.querySelectorAll('.history-star').forEach(button => button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const progress = progressFor(state.activeBank, button.dataset.id);
      progress.starred = !progress.starred;
      progress.updatedAt = Date.now();
      saveState();
      renderHistory();
      updateHeader();
    }));
  }

  async function initializeAuth() {
    const config = window.CHEM_REVIEW_CONFIG || {};
    if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase) {
      $('#auth-message').textContent = '尚未啟用雲端同步；之後加入 config.js 與 Supabase 設定即可啟用。';
      return;
    }
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    const { data } = await supabaseClient.auth.getSession();
    await setUser(data.session?.user || null);
    supabaseClient.auth.onAuthStateChange((_event, session) => setUser(session?.user || null));
  }

  async function setUser(user) {
    currentUser = user;
    $('#account-signed-out').classList.toggle('hidden', Boolean(user));
    $('#account-signed-in').classList.toggle('hidden', !user);
    $('#account-email').textContent = user?.email || '';
    $('#sync-dot').classList.toggle('online', Boolean(user));
    if (!user) {
      $('#sync-status').textContent = '進度會先儲存在這台裝置';
      return;
    }
    $('#sync-status').textContent = '正在讀取雲端進度…';
    const { data, error } = await supabaseClient.from('chemistry_study_progress').select('state, updated_at').eq('user_id', user.id).maybeSingle();
    if (!error && data?.state && Number(data.state.updatedAt || 0) > Number(state.updatedAt || 0)) {
      state = data.state;
      ensureStateShape();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderQuestion(getNextQuestion(false));
    } else {
      await saveRemote();
    }
    $('#sync-status').textContent = error ? `雲端讀取失敗：${error.message}` : '進度已同步到雲端';
  }

  async function signIn() {
    if (!supabaseClient) return void ($('#auth-message').textContent = '尚未設定 Supabase。');
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: $('#auth-email').value.trim(), password: $('#auth-password').value
    });
    $('#auth-message').textContent = error ? error.message : '登入成功，正在同步。';
  }

  async function signUp() {
    if (!supabaseClient) return void ($('#auth-message').textContent = '尚未設定 Supabase。');
    const { data, error } = await supabaseClient.auth.signUp({
      email: $('#auth-email').value.trim(), password: $('#auth-password').value
    });
    $('#auth-message').textContent = error ? error.message : (data.session ? '帳號建立完成。' : '帳號已建立，請到信箱完成驗證後再登入。');
  }

  async function signOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    $('#auth-message').textContent = '已登出；本機進度仍保留。';
  }

  async function init() {
    try {
      const [examResponse, practiceResponse] = await Promise.all([
        fetch(`data/exam.json?v=${DATA_VERSION}`),
        fetch(`data/practice.json?v=${DATA_VERSION}`)
      ]);
      if (!examResponse.ok || !practiceResponse.ok) throw new Error('題庫檔案讀取失敗');
      banks.exam = (await examResponse.json()).map(question => normalizeQuestion(question, 'exam'));
      banks.practice = (await practiceResponse.json()).map(question => normalizeQuestion(question, 'practice'));
      $('#exam-count').textContent = banks.exam.length;
      $('#practice-count').textContent = banks.practice.length;
      ensureStateShape();
      renderQuestion(getNextQuestion(false));
      initializeAuth();
    } catch (error) {
      card.innerHTML = `<div class="empty-state"><div><h2>題庫載入失敗</h2><p>${escapeHtml(error.message)}</p><p class="subtitle">請用本機伺服器或 GitHub Pages 開啟，不要直接雙擊 index.html。</p></div></div>`;
    }
  }

  document.querySelectorAll('.bank-tab').forEach(tab => tab.addEventListener('click', () => switchBank(tab.dataset.bank)));
  $('#star-practice-button').addEventListener('click', enterStarMode);
  $('#refresh-button').addEventListener('click', () => {
    if (confirm('只刷新本輪出題順序；星號、作答與答錯紀錄都會保留。確定刷新嗎？')) {
      refreshQueue(state.activeBank, state.mode);
      renderQuestion(getNextQuestion(false));
    }
  });
  $('#history-button').addEventListener('click', () => { renderHistory(); historyDialog.showModal(); });
  $('#history-search').addEventListener('input', renderHistory);
  $('#history-filter').addEventListener('change', renderHistory);
  $('#account-button').addEventListener('click', () => accountDialog.showModal());
  $('#sign-in-button').addEventListener('click', signIn);
  $('#sign-up-button').addEventListener('click', signUp);
  $('#sign-out-button').addEventListener('click', signOut);

  init();
})();
