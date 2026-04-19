const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_CODE = process.env.ADMIN_CODE || 'mishpaha2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// כל הנתונים נשמרים בזיכרון (מספיק ליום אחד)
let questions = [];
let gameState = {
  status: 'collecting', // collecting | lobby | question | answer | finished
  currentIndex: -1,
  questionOrder: [],
  questionStartTime: null,
  players: {}, // socketId -> { name, score, answered, lastPoints }
};
let questionTimer = null;

// --- API ---

app.post('/api/questions', (req, res) => {
  const { text, type, options, correctAnswer, submittedBy } = req.body;
  if (!text || !type || correctAnswer === undefined || correctAnswer === null) {
    return res.status(400).json({ error: 'חסרים שדות' });
  }
  if (type === 'multiple' && (!options || options.length !== 4)) {
    return res.status(400).json({ error: 'צריך בדיוק 4 אפשרויות' });
  }
  const q = {
    id: Date.now(),
    text: text.trim(),
    type,
    options: type === 'truefalse' ? ['נכון', 'לא נכון'] : options.map(o => o.trim()),
    correctAnswer: Number(correctAnswer),
    submittedBy: (submittedBy || 'אנונימי').trim(),
  };
  questions.push(q);
  io.emit('questions-count', questions.length);
  res.json({ success: true, count: questions.length });
});

app.get('/api/questions', (req, res) => {
  if (req.headers['x-admin-code'] !== ADMIN_CODE) return res.status(403).json({ error: 'אין הרשאה' });
  res.json(questions);
});

app.delete('/api/questions/:id', (req, res) => {
  if (req.headers['x-admin-code'] !== ADMIN_CODE) return res.status(403).json({ error: 'אין הרשאה' });
  questions = questions.filter(q => q.id !== Number(req.params.id));
  io.emit('questions-count', questions.length);
  res.json({ success: true });
});

// --- Socket.io ---

io.on('connection', (socket) => {
  socket.emit('init', { status: gameState.status, questionCount: questions.length });

  socket.on('join-lobby', ({ name }) => {
    if (!name || !name.trim()) return;
    if (gameState.status === 'finished') {
      socket.emit('join-error', 'המשחק כבר הסתיים');
      return;
    }
    gameState.players[socket.id] = { name: name.trim(), score: 0, answered: false, lastPoints: 0 };
    broadcastPlayers();
    socket.emit('joined', { name: name.trim(), status: gameState.status });
  });

  socket.on('admin-verify', (code, callback) => {
    callback(code === ADMIN_CODE);
  });

  socket.on('admin-start', (code) => {
    if (code !== ADMIN_CODE || questions.length === 0) return;
    gameState.questionOrder = shuffle([...Array(questions.length).keys()]);
    gameState.currentIndex = -1;
    gameState.status = 'lobby';
    Object.values(gameState.players).forEach(p => { p.score = 0; p.answered = false; p.lastPoints = 0; });
    io.emit('game-started');
    setTimeout(() => sendNextQuestion(), 2000);
  });

  socket.on('admin-next', (code) => {
    if (code !== ADMIN_CODE || gameState.status !== 'answer') return;
    sendNextQuestion();
  });

  socket.on('admin-reset', (code) => {
    if (code !== ADMIN_CODE) return;
    if (questionTimer) clearTimeout(questionTimer);
    questions = [];
    gameState = { status: 'collecting', currentIndex: -1, questionOrder: [], questionStartTime: null, players: {} };
    io.emit('game-reset');
  });

  socket.on('submit-answer', (answerIndex) => {
    if (gameState.status !== 'question') return;
    const player = gameState.players[socket.id];
    if (!player || player.answered) return;

    player.answered = true;
    const q = questions[gameState.questionOrder[gameState.currentIndex]];
    const isCorrect = Number(answerIndex) === q.correctAnswer;
    const elapsed = Date.now() - gameState.questionStartTime;
    const timeLeft = Math.max(0, 20000 - elapsed);
    const points = isCorrect ? Math.round(500 + (timeLeft / 20000) * 500) : 0;
    player.score += points;
    player.lastPoints = points;

    socket.emit('answer-result', { isCorrect, points });
    broadcastPlayers();

    const allAnswered = Object.values(gameState.players).every(p => p.answered);
    if (allAnswered && Object.keys(gameState.players).length > 0) {
      if (questionTimer) clearTimeout(questionTimer);
      setTimeout(() => revealAnswer(), 500);
    }
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    broadcastPlayers();
  });
});

function sendNextQuestion() {
  gameState.currentIndex++;
  if (gameState.currentIndex >= gameState.questionOrder.length) {
    gameState.status = 'finished';
    io.emit('game-finished', getLeaderboard());
    return;
  }
  Object.values(gameState.players).forEach(p => { p.answered = false; p.lastPoints = 0; });
  const q = questions[gameState.questionOrder[gameState.currentIndex]];
  gameState.status = 'question';
  gameState.questionStartTime = Date.now();
  io.emit('new-question', {
    number: gameState.currentIndex + 1,
    total: questions.length,
    text: q.text,
    type: q.type,
    options: q.options,
    submittedBy: q.submittedBy,
  });
  if (questionTimer) clearTimeout(questionTimer);
  questionTimer = setTimeout(() => revealAnswer(), 20000);
}

function revealAnswer() {
  if (gameState.status !== 'question') return;
  gameState.status = 'answer';
  const q = questions[gameState.questionOrder[gameState.currentIndex]];
  io.emit('reveal-answer', {
    correctAnswer: q.correctAnswer,
    correctText: q.options[q.correctAnswer],
    leaderboard: getLeaderboard(),
    isLast: gameState.currentIndex >= questions.length - 1,
  });
}

function broadcastPlayers() {
  io.emit('players-update', Object.values(gameState.players).map(p => ({
    name: p.name, score: p.score, answered: p.answered,
  })));
}

function getLeaderboard() {
  return Object.values(gameState.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, lastPoints: p.lastPoints }));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ השרת פועל על פורט ${PORT}`);
  console.log(`🔑 קוד מנהל: ${ADMIN_CODE}`);
});
