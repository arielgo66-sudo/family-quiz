const socket = io();

// --- State ---
let adminCode = null;
let myName = null;
let myAnswered = false;
let lastAnswerResult = null;
let timerInterval = null;
let currentQTotal = 0;
let currentQNumber = 0;
let questionType = 'multiple';

// =================== SOCKET EVENTS ===================

socket.on('init', ({ status, questionCount }) => {
  updateQuestionsCount(questionCount);
});

socket.on('questions-count', (count) => {
  updateQuestionsCount(count);
});

socket.on('game-started', () => {
  if (!adminCode) {
    showScreen('screen-lobby');
  } else {
    showAdminGamePanel();
  }
});

socket.on('players-update', (players) => {
  renderLobbyPlayers(players);
  renderAdminPlayers(players);
  if (myAnswered) updateAnsweredProgress(players);
});

socket.on('joined', ({ name, status }) => {
  myName = name;
  if (status === 'question' || status === 'answer') {
    showLobbyMsg('המשחק כבר התחיל, ממתין לשאלה הבאה...');
  }
  showScreen('screen-lobby');
});

socket.on('join-error', (msg) => {
  const el = document.getElementById('join-error');
  el.textContent = msg;
  el.style.display = 'block';
});

socket.on('new-question', (q) => {
  myAnswered = false;
  lastAnswerResult = null;
  currentQTotal = q.total;
  currentQNumber = q.number;
  showQuestion(q);
  if (adminCode) updateAdminQuestion(q);
});

socket.on('answer-result', (result) => {
  lastAnswerResult = result;
  myAnswered = true;
  showWaiting(result);
});

socket.on('reveal-answer', (data) => {
  stopTimer();
  showAnswerReveal(data);
  if (adminCode) showAdminReveal(data);
});

socket.on('game-finished', (leaderboard) => {
  stopTimer();
  showFinal(leaderboard);
  if (adminCode) showAdminFinished(leaderboard);
  spawnConfetti();
});

socket.on('game-reset', () => {
  window.location.reload();
});

// =================== SCREEN MANAGEMENT ===================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  // Auto-focus first input
  const input = document.querySelector(`#${id} input:not([type="radio"])`);
  if (input) setTimeout(() => input.focus(), 100);
}

function updateQuestionsCount(count) {
  const el = document.getElementById('questions-count-label');
  if (el) el.textContent = count > 0 ? `✅ ${count} שאלות הוגשו עד כה` : '';
  const adminEl = document.getElementById('admin-q-count');
  if (adminEl) adminEl.textContent = count;
}

// =================== SUBMIT QUESTION ===================

function setQuestionType(type) {
  questionType = type;
  document.getElementById('type-btn-multiple').classList.toggle('active', type === 'multiple');
  document.getElementById('type-btn-truefalse').classList.toggle('active', type === 'truefalse');
  document.getElementById('options-section').style.display = type === 'multiple' ? 'block' : 'none';
  document.getElementById('tf-section').style.display = type === 'truefalse' ? 'block' : 'none';
}

async function submitQuestion() {
  const name = document.getElementById('submit-name').value.trim();
  const text = document.getElementById('submit-question').value.trim();
  const errorEl = document.getElementById('submit-error');
  errorEl.style.display = 'none';

  if (!name) { showError(errorEl, 'נא להכניס את שמך'); return; }
  if (!text) { showError(errorEl, 'נא לכתוב שאלה'); return; }

  let options = [], correctAnswer;

  if (questionType === 'multiple') {
    options = [0, 1, 2, 3].map(i => document.getElementById(`option-text-${i}`).value.trim());
    const emptyOpt = options.findIndex(o => !o);
    if (emptyOpt !== -1) { showError(errorEl, `נא למלא את אפשרות ${emptyOpt + 1}`); return; }
    const checked = document.querySelector('input[name="correct"]:checked');
    if (!checked) { showError(errorEl, 'נא לסמן את התשובה הנכונה'); return; }
    correctAnswer = Number(checked.value);
  } else {
    const checked = document.querySelector('input[name="tf-correct"]:checked');
    if (!checked) { showError(errorEl, 'נא לבחור נכון או לא נכון'); return; }
    correctAnswer = Number(checked.value);
    options = ['נכון', 'לא נכון'];
  }

  try {
    const res = await fetch('/api/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, type: questionType, options, correctAnswer, submittedBy: name }),
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('submitted-msg').textContent = `סה"כ ${data.count} שאלות הוגשו. תודה, ${name}! 🎉`;
      showScreen('screen-submitted');
      // Save name for next question
      document.getElementById('submit-name').value = name;
    } else {
      showError(errorEl, data.error || 'שגיאה, נסה שוב');
    }
  } catch {
    showError(errorEl, 'שגיאת רשת, נסה שוב');
  }
}

function resetSubmitForm() {
  document.getElementById('submit-question').value = '';
  document.querySelectorAll('.option-input').forEach(i => i.value = '');
  document.querySelectorAll('input[name="correct"]').forEach(r => r.checked = false);
  document.querySelectorAll('input[name="tf-correct"]').forEach(r => r.checked = false);
  document.getElementById('submit-error').style.display = 'none';
  setQuestionType('multiple');
}

// =================== JOIN GAME ===================

function joinGame() {
  const name = document.getElementById('player-name').value.trim();
  const errorEl = document.getElementById('join-error');
  if (!name) { errorEl.textContent = 'נא להכניס שם'; errorEl.style.display = 'block'; return; }
  errorEl.style.display = 'none';
  socket.emit('join-lobby', { name });
}

function showLobbyMsg(msg) {
  const hint = document.querySelector('#screen-lobby .hint-text');
  if (hint) hint.textContent = msg;
}

function renderLobbyPlayers(players) {
  const el = document.getElementById('lobby-players');
  if (!el) return;
  el.innerHTML = players.map(p =>
    `<div class="player-chip ${p.answered ? 'answered' : ''}">${p.name}</div>`
  ).join('');
  const countEl = document.getElementById('lobby-q-count');
  // Shown via questions-count event
}

// =================== QUESTION ===================

let timerSeconds = 20;

function showQuestion(q) {
  document.getElementById('q-progress').textContent = `שאלה ${q.number} מתוך ${q.total}`;
  document.getElementById('q-author').textContent = `נשאלה ע"י ${q.submittedBy}`;
  document.getElementById('q-text').textContent = q.text;

  const grid = document.getElementById('answer-buttons');
  grid.innerHTML = '';

  if (q.type === 'truefalse') {
    grid.style.gridTemplateColumns = '1fr 1fr';
    ['נכון ✓', 'לא נכון ✗'].forEach((label, i) => {
      const btn = document.createElement('button');
      btn.className = `answer-btn ${i === 0 ? 'tf-true-btn' : 'tf-false-btn'}`;
      btn.textContent = label;
      btn.onclick = () => submitAnswer(i, grid);
      grid.appendChild(btn);
    });
  } else {
    grid.style.gridTemplateColumns = '1fr 1fr';
    q.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = `answer-btn color-${i}`;
      btn.textContent = opt;
      btn.onclick = () => submitAnswer(i, grid);
      grid.appendChild(btn);
    });
  }

  showScreen('screen-question');
  startTimer(20);
}

function submitAnswer(index, grid) {
  if (myAnswered) return;
  // Disable all buttons
  grid.querySelectorAll('.answer-btn').forEach(b => b.disabled = true);
  socket.emit('submit-answer', index);
}

// =================== TIMER ===================

function startTimer(seconds) {
  stopTimer();
  timerSeconds = seconds;
  const numEl = document.getElementById('timer-num');
  const circle = document.getElementById('timer-circle');
  const circumference = 100;

  updateTimerDisplay(seconds, numEl, circle, circumference);

  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerDisplay(timerSeconds, numEl, circle, circumference);
    if (timerSeconds <= 5) {
      circle.style.stroke = '#ef5350';
      numEl.style.color = '#ef5350';
    }
    if (timerSeconds <= 0) stopTimer();
  }, 1000);
}

function updateTimerDisplay(s, numEl, circle, circumference) {
  numEl.textContent = Math.max(0, s);
  const offset = circumference - (s / 20) * circumference;
  circle.style.strokeDashoffset = offset;
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// =================== WAITING ===================

function showWaiting(result) {
  const icon = document.getElementById('wait-icon');
  const text = document.getElementById('wait-text');
  if (result.isCorrect) {
    icon.textContent = '✅';
    text.textContent = `נכון! +${result.points} נקודות`;
  } else {
    icon.textContent = '❌';
    text.textContent = 'לא נכון...';
  }
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-label').textContent = '';
  showScreen('screen-waiting');
}

function updateAnsweredProgress(players) {
  const total = players.length;
  const answered = players.filter(p => p.answered).length;
  const pct = total > 0 ? (answered / total) * 100 : 0;
  const bar = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = `ענו ${answered} מתוך ${total}`;
}

// =================== ANSWER REVEAL ===================

function showAnswerReveal(data) {
  document.getElementById('correct-box').textContent = `✅ התשובה הנכונה: ${data.correctText}`;

  const resultBox = document.getElementById('my-result-box');
  if (lastAnswerResult) {
    if (lastAnswerResult.isCorrect) {
      resultBox.className = 'my-result correct';
      resultBox.textContent = `כל הכבוד! קיבלת +${lastAnswerResult.points} נקודות 🎉`;
    } else {
      resultBox.className = 'my-result wrong';
      resultBox.textContent = 'לא נכון הפעם 😕';
    }
  } else {
    resultBox.className = 'my-result no-answer';
    resultBox.textContent = 'לא ענית בזמן ⏰';
  }

  renderLeaderboard(data.leaderboard, 'mid-leaderboard', 5);

  const hint = document.getElementById('answer-hint');
  if (hint) hint.textContent = data.isLast ? 'זו הייתה השאלה האחרונה!' : 'ממתין לשאלה הבאה...';

  showScreen('screen-answer');
}

// =================== FINAL ===================

function showFinal(leaderboard) {
  renderLeaderboard(leaderboard, 'final-leaderboard', 999);
  showScreen('screen-final');
}

function renderLeaderboard(leaderboard, elId, limit) {
  const el = document.getElementById(elId);
  if (!el) return;
  const medals = ['🥇', '🥈', '🥉'];
  el.innerHTML = leaderboard.slice(0, limit).map((p, i) => `
    <div class="leaderboard-row pop-in" style="animation-delay:${i * 0.07}s">
      <span class="rank">${medals[i] || p.rank}</span>
      <span class="player-name">${p.name}</span>
      ${p.lastPoints ? `<span class="player-delta">+${p.lastPoints}</span>` : ''}
      <span class="player-score">${p.score}</span>
    </div>
  `).join('');
}

// =================== CONFETTI ===================

function spawnConfetti() {
  const container = document.getElementById('confetti');
  if (!container) return;
  const colors = ['#e21b3c', '#1368ce', '#ffa602', '#26890c', '#ffffff', '#9b59b6'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (1.5 + Math.random() * 2) + 's';
    piece.style.animationDelay = (Math.random() * 1.5) + 's';
    piece.style.width = piece.style.height = (6 + Math.random() * 10) + 'px';
    container.appendChild(piece);
    setTimeout(() => piece.remove(), 5000);
  }
}

// =================== ADMIN ===================

function adminLogin() {
  const code = document.getElementById('admin-code-input').value;
  socket.emit('admin-verify', code, (ok) => {
    if (ok) {
      adminCode = code;
      document.getElementById('admin-login-error').style.display = 'none';
      loadAdminPanel();
    } else {
      document.getElementById('admin-login-error').style.display = 'block';
    }
  });
}

async function loadAdminPanel() {
  showScreen('screen-admin');
  const res = await fetch('/api/questions', { headers: { 'x-admin-code': adminCode } });
  const qs = await res.json();
  renderAdminQuestions(qs);
}

function renderAdminQuestions(qs) {
  const el = document.getElementById('admin-questions-list');
  const countEl = document.getElementById('admin-q-count');
  if (countEl) countEl.textContent = qs.length;
  if (!el) return;
  if (qs.length === 0) {
    el.innerHTML = '<p style="color:var(--hint);font-size:0.9rem;">עדיין אין שאלות</p>';
    return;
  }
  el.innerHTML = qs.map(q => `
    <div class="admin-q-item">
      <span>${q.submittedBy}: ${q.text.substring(0, 60)}${q.text.length > 60 ? '...' : ''}</span>
      <button onclick="deleteQuestion(${q.id})">🗑️</button>
    </div>
  `).join('');
}

async function deleteQuestion(id) {
  await fetch(`/api/questions/${id}`, {
    method: 'DELETE',
    headers: { 'x-admin-code': adminCode },
  });
  loadAdminPanel();
}

function renderAdminPlayers(players) {
  const el = document.getElementById('admin-players-list');
  const countEl = document.getElementById('admin-player-count');
  if (countEl) countEl.textContent = players.length;
  if (!el) return;
  el.innerHTML = players.map(p =>
    `<div class="player-chip ${p.answered ? 'answered' : ''}">${p.name}${p.score ? ` (${p.score})` : ''}</div>`
  ).join('');
}

function adminStart() {
  const errorEl = document.getElementById('start-error');
  errorEl.style.display = 'none';
  socket.emit('admin-start', adminCode);
}

function showAdminGamePanel() {
  document.getElementById('admin-collecting').style.display = 'none';
  document.getElementById('admin-game').style.display = 'block';
  document.getElementById('admin-finished').style.display = 'none';
}

function updateAdminQuestion(q) {
  document.getElementById('admin-q-label').textContent = `שאלה ${q.number} מתוך ${q.total}`;
  document.getElementById('admin-q-text').textContent = q.text;
  document.getElementById('admin-answered-label').textContent = `ממתין לתשובות...`;
  document.getElementById('btn-next').style.display = 'none';
  document.getElementById('admin-mid-leaderboard').style.display = 'none';
}

function showAdminReveal(data) {
  document.getElementById('admin-answered-label').textContent = `תשובה נכונה: ${data.correctText}`;
  renderLeaderboard(data.leaderboard, 'admin-mid-leaderboard', 999);
  document.getElementById('admin-mid-leaderboard').style.display = 'flex';
  if (!data.isLast) {
    document.getElementById('btn-next').style.display = 'block';
  } else {
    document.getElementById('btn-next').style.display = 'none';
  }
}

function adminNext() {
  document.getElementById('btn-next').style.display = 'none';
  socket.emit('admin-next', adminCode);
}

function showAdminFinished(leaderboard) {
  document.getElementById('admin-game').style.display = 'none';
  document.getElementById('admin-finished').style.display = 'block';
  renderLeaderboard(leaderboard, 'admin-final-leaderboard', 999);
}

function adminReset() {
  if (!confirm('לאפס את כל המשחק? כל השאלות והניקוד יימחקו!')) return;
  socket.emit('admin-reset', adminCode);
}

// =================== UTILS ===================

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}
