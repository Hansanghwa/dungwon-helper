'use strict';

// ============================================================
// 등원 도우미 — 알람 + 체크리스트 + ntfy.sh 실시간 동기화
//
// 아키텍처 (DESIGN.md ADR-001):
//  - 상태의 ground truth 는 ntfy 이벤트 로그(토픽 `<topic>-log`).
//    화면 상태는 이벤트 재생(replay) 결과다.
//  - 사람용 푸시(아빠 폰 ntfy 앱)는 메인 토픽 `<topic>` 으로 따로 발행.
//  - ntfy.sh 무료 캐시(12h)로 아침 동안의 상태 재구성이 가능.
// ============================================================

const LS_SETTINGS = 'dungwon.settings.v1';
const LS_CHECKS = 'dungwon.checks.'; // + 날짜 키. 오프라인 대비 로컬 미러

const DEFAULT_STAGES = [
  { id: 'wake',  time: '07:00', emoji: '🌅', label: '기상',            check: true },
  { id: 'study', time: '07:02', emoji: '📚', label: '패드 학습 (20분)', check: true },
  { id: 'meal',  time: '07:20', emoji: '🍚', label: '아침식사',        check: true },
  { id: 'wash',  time: '07:50', emoji: '🪥', label: '양치·세수',       check: true },
  { id: 'dress', time: '08:00', emoji: '👕', label: '옷 입기',         check: true },
  { id: 'bag',   time: '08:10', emoji: '🎒', label: '가방 확인',       check: true },
  { id: 'rest',  time: '08:15', emoji: '📖', label: '휴식 (책 읽기)',  check: false },
  { id: 'go',    time: '08:32', emoji: '🏫', label: '등교!',           check: true },
];

const DEFAULT_SETTINGS = {
  server: 'https://ntfy.sh',
  topic: '',
  kids: [{ id: 'k1', name: '첫째' }, { id: 'k2', name: '둘째' }],
  stages: DEFAULT_STAGES,
  weekendOff: true,
  parentMode: false,
  lateAlertTime: '08:35',
};

// ---------- 상태 ----------
let settings = loadSettings();
const checks = new Map();      // `${date}|${kid}|${stage}` -> ts
const firedAlarms = new Set(); // `${date}|${stage}` — 같은 알람 중복 발화 방지
const seenEventIds = new Set(); // ntfy 메시지 id — replay/SSE 중복 수신 dedup
let audioCtx = null;
let eventSource = null;
let allDoneNotified = false;

// ---------- 유틸 ----------
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const nowHHMM = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const checkKey = (date, kid, stage) => `${date}|${kid}|${stage}`;

let currentDate = dateKey();

function activeKids() {
  return settings.kids.filter((k) => k.name.trim() !== '');
}

function isSchoolDay(d = new Date()) {
  if (!settings.weekendOff) return true;
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

function checkableStages() {
  return settings.stages.filter((s) => s.check);
}

// ---------- 설정 저장/로드 ----------
function loadSettings() {
  let s = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) s = { ...s, ...JSON.parse(raw) };
  } catch (e) { /* 손상된 설정은 기본값으로 */ }
  // URL 파라미터로 기기 초기 설정 지원: ?topic=xxx&mode=parent (ADR-002)
  const params = new URLSearchParams(location.search);
  if (params.get('topic')) s.topic = params.get('topic').trim();
  if (params.get('mode') === 'parent') s.parentMode = true;
  return s;
}

function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
}

// ---------- 로컬 체크 미러 (ntfy 장애 시에도 패드 단독 동작 유지) ----------
function persistChecks() {
  const today = {};
  for (const [k, ts] of checks) {
    if (k.startsWith(currentDate)) today[k] = ts;
  }
  localStorage.setItem(LS_CHECKS + currentDate, JSON.stringify(today));
}

function restoreChecks() {
  try {
    const raw = localStorage.getItem(LS_CHECKS + currentDate);
    if (raw) for (const [k, ts] of Object.entries(JSON.parse(raw))) checks.set(k, ts);
  } catch (e) { /* 미러 손상은 무시 — ntfy replay 가 복구 */ }
}

// ---------- 이벤트 처리 (§1.4 registry — 새 이벤트 타입 = 등록 한 줄) ----------
const EVENT_HANDLERS = {
  check(ev) { checks.set(checkKey(ev.date, ev.kid, ev.stage), ev.ts); },
  uncheck(ev) { checks.delete(checkKey(ev.date, ev.kid, ev.stage)); },
  sos(ev) {
    if (settings.parentMode && ev.date === currentDate) $('sosBanner').hidden = false;
  },
};

function applyEvent(ev) {
  const handler = EVENT_HANDLERS[ev.type];
  if (!handler) return; // 미래 버전이 보낸 미지의 타입은 조용히 통과 (하위 호환)
  handler(ev);
  persistChecks();
  render();
}

// ---------- ntfy 발행/구독 ----------
function logTopic() { return settings.topic + '-log'; }

async function ntfyPublish(body) {
  // JSON 발행(루트 POST)을 쓰는 이유: 헤더 방식은 한글 title 이 깨진다
  try {
    await fetch(settings.server, { method: 'POST', body: JSON.stringify(body) });
    return true;
  } catch (e) {
    setConnBar('인터넷 연결 안 됨 — 체크는 이 기기에 저장돼요');
    return false;
  }
}

function publishEvent(ev) {
  return ntfyPublish({ topic: logTopic(), message: JSON.stringify(ev), title: 'ev' });
}

function publishPush(message, { title = '등원 도우미', priority = 3, tags = [] } = {}) {
  return ntfyPublish({ topic: settings.topic, message, title, priority, tags });
}

function handleNtfyMessage(m) {
  if (m.event !== 'message' || m.id && seenEventIds.has(m.id)) return;
  if (m.id) seenEventIds.add(m.id);
  let ev;
  try { ev = JSON.parse(m.message); } catch (e) { return; } // 로그 토픽에 섞인 비정형 메시지 무시
  if (!ev || !ev.type) return;
  applyEvent(ev);
}

async function replayEvents() {
  if (!settings.topic) return;
  // 캐시 재생으로 오늘 상태 재구성 — 18h 면 자정 이후 전부 커버
  try {
    const res = await fetch(`${settings.server}/${logTopic()}/json?poll=1&since=18h`);
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { handleNtfyMessage(JSON.parse(line)); } catch (e) { /* 깨진 라인 무시 */ }
    }
    setConnBar(null);
  } catch (e) {
    setConnBar('서버 연결 실패 — 로컬 상태로 표시 중');
  }
}

function subscribe() {
  if (!settings.topic) return;
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`${settings.server}/${logTopic()}/sse`);
  eventSource.onopen = () => setConnBar(null);
  eventSource.onmessage = (e) => {
    try { handleNtfyMessage(JSON.parse(e.data)); } catch (err) { /* 무시 */ }
  };
  eventSource.onerror = () => {
    // EventSource 는 자동 재접속하지만, 완전히 닫힌 경우엔 수동 재시작
    if (eventSource.readyState === EventSource.CLOSED) {
      setConnBar('연결 끊김 — 다시 연결 중...');
      setTimeout(subscribe, 5000);
    }
  };
}

function setConnBar(msg) {
  const bar = $('connBar');
  bar.hidden = !msg;
  if (msg) bar.textContent = '⚠️ ' + msg;
}

// ---------- 체크 동작 ----------
function toggleCheck(kid, stage) {
  if (settings.parentMode) return; // 부모 모드는 보기 전용
  const key = checkKey(currentDate, kid.id, stage.id);
  const now = new Date();
  const type = checks.has(key) ? 'uncheck' : 'check';
  const ev = { v: 1, type, kid: kid.id, stage: stage.id, date: currentDate, ts: now.getTime() };
  applyEvent(ev); // 낙관적 반영 — 발행 실패해도 로컬은 유지
  publishEvent(ev);
  if (type === 'check') {
    publishPush(`✅ ${kid.name} — ${stage.label} (${nowHHMM(now)})`, { tags: ['white_check_mark'] });
    chime('short');
    maybeNotifyAllDone();
  }
}

function maybeNotifyAllDone() {
  if (allDoneNotified) return;
  const kids = activeKids();
  const done = checkableStages().every((s) =>
    kids.every((k) => checks.has(checkKey(currentDate, k.id, s.id))));
  if (done && kids.length > 0) {
    allDoneNotified = true;
    publishPush('🎉 오늘 등원 루틴 모두 완료! 아이들이 등교했어요', { priority: 4, tags: ['tada'] });
  }
}

function sendSOS() {
  const ev = { v: 1, type: 'sos', date: currentDate, ts: Date.now() };
  publishEvent(ev);
  publishPush('🚨 아이가 아빠를 찾아요! 카카오톡 보이스톡을 걸어주세요', {
    title: '긴급 호출', priority: 5, tags: ['rotating_light'],
  });
  speak('아빠에게 알림을 보냈어요. 곧 전화가 올 거예요.');
}

// ---------- 알람 엔진 ----------
function tick() {
  const now = new Date();
  // 자정 넘어감 → 새 날 리셋
  if (dateKey(now) !== currentDate) {
    currentDate = dateKey(now);
    checks.clear();
    firedAlarms.clear();
    seenEventIds.clear(); // §2.7: 하루 지난 dedup id 는 더 안 옴 — 여기서 비워 누수 방지
    allDoneNotified = false;
    restoreChecks();
    render();
  }
  updateClock(now);
  if (!isSchoolDay(now) || settings.parentMode) return;

  // 정각 == 비교가 아니라 2분 유예 창: 탭이 잠깐 멈췄다 깨어나도 알람이 유실되지 않게
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  for (const stage of settings.stages) {
    const fireKey = `${currentDate}|${stage.id}`;
    const delta = nowMin - toMin(stage.time);
    if (delta >= 0 && delta <= 2 && !firedAlarms.has(fireKey)) {
      firedAlarms.add(fireKey);
      fireAlarm(stage);
    }
  }
  const lateKey = `${currentDate}|__late__`;
  const lateDelta = nowMin - toMin(settings.lateAlertTime);
  if (lateDelta >= 0 && lateDelta <= 2 && !firedAlarms.has(lateKey)) {
    firedAlarms.add(lateKey);
    notifyLate();
  }
}

function fireAlarm(stage) {
  chime('long');
  speak(`${stage.label.replace(/\(.*\)/, '')} 시간이에요!`);
  const banner = $('nowBanner');
  banner.classList.add('alarming');
  setTimeout(() => banner.classList.remove('alarming'), 30000);
  render();
}

function notifyLate() {
  const missing = [];
  for (const kid of activeKids()) {
    for (const s of checkableStages()) {
      if (!checks.has(checkKey(currentDate, kid.id, s.id))) missing.push(`${kid.name}-${s.label}`);
    }
  }
  if (missing.length > 0) {
    publishPush(`⏰ ${settings.lateAlertTime} 기준 미완료: ${missing.join(', ')}`, {
      title: '등원 체크 미완료', priority: 4, tags: ['warning'],
    });
  }
}

// ---------- 소리·음성 ----------
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep(freq, startAt, dur) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.3, startAt);
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur);
}

function chime(kind) {
  if (!audioCtx) return; // 오디오 미해제 상태(첫 탭 전)면 조용히 통과
  ensureAudio();
  const t = audioCtx.currentTime;
  if (kind === 'short') {
    beep(880, t, 0.15);
  } else {
    // 알람: 딩동 멜로디 3회 반복
    for (let i = 0; i < 3; i++) {
      const base = t + i * 1.2;
      beep(659, base, 0.3);
      beep(880, base + 0.35, 0.5);
    }
  }
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

async function keepAwake() {
  // 패드가 아침 내내 켜져 있어야 하므로 화면 잠금 방지 (미지원 브라우저는 통과 —
  // 그 경우 기기 설정에서 자동 잠금을 꺼야 한다. README 참고)
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch (e) { /* 권한 거부 시 무시 */ }
}

// ---------- 렌더 ----------
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function updateClock(now = new Date()) {
  $('clock').textContent = nowHHMM(now);
  $('dateLabel').textContent =
    `${now.getMonth() + 1}월 ${now.getDate()}일 (${WEEKDAYS[now.getDay()]})`;
  updateCountdown(now);
  updateNowBanner(now);
}

function goStage() {
  return settings.stages[settings.stages.length - 1];
}

function updateCountdown(now) {
  const el = $('countdown');
  if (!isSchoolDay(now)) { el.textContent = '오늘은 쉬는 날 🏖️'; return; }
  const [h, m] = goStage().time.split(':').map(Number);
  const goAt = new Date(now); goAt.setHours(h, m, 0, 0);
  const diffMin = Math.ceil((goAt - now) / 60000);
  if (diffMin > 0 && diffMin <= 120) el.textContent = `등교까지 ${diffMin}분`;
  else el.textContent = '';
}

function currentStage(now = new Date()) {
  if (!isSchoolDay(now)) return null;
  const hhmm = nowHHMM(now);
  let cur = null;
  for (const s of settings.stages) if (s.time <= hhmm) cur = s;
  return cur;
}

function updateNowBanner(now) {
  const cur = currentStage(now);
  $('nowStage').textContent = cur
    ? `${cur.emoji} ${cur.label}`
    : (isSchoolDay(now) ? '⏰ 아직 시작 전이에요' : '🏖️ 오늘은 쉬는 날!');
}

function render() {
  const kids = activeKids();
  const cur = currentStage();
  const list = $('stageList');
  list.textContent = '';

  for (const stage of settings.stages) {
    const row = document.createElement('div');
    row.className = 'stage-row';
    if (cur && stage.id === cur.id) row.classList.add('current');
    else if (cur && stage.time < cur.time) row.classList.add('past');

    const time = document.createElement('div');
    time.className = 'stage-time';
    time.textContent = stage.time;

    const label = document.createElement('div');
    label.className = 'stage-label';
    label.innerHTML = `<span class="emoji"></span>`;
    label.querySelector('.emoji').textContent = stage.emoji;
    label.append(stage.label);

    row.append(time, label);

    if (stage.check) {
      for (const kid of kids) {
        const btn = document.createElement('button');
        btn.className = 'kid-check';
        const checked = checks.has(checkKey(currentDate, kid.id, stage.id));
        if (checked) btn.classList.add('checked');
        btn.textContent = checked ? `${kid.name} ✔` : kid.name;
        btn.disabled = settings.parentMode;
        btn.addEventListener('click', () => toggleCheck(kid, stage));
        row.append(btn);
      }
    }
    list.append(row);
  }

  const allDone = kids.length > 0 && checkableStages().every((s) =>
    kids.every((k) => checks.has(checkKey(currentDate, k.id, s.id))));
  $('doneBanner').hidden = !allDone;
  $('sosBtn').hidden = settings.parentMode;
}

// ---------- 설정 UI ----------
function openSettings() {
  $('setTopic').value = settings.topic;
  $('setKid1').value = settings.kids[0]?.name ?? '';
  $('setKid2').value = settings.kids[1]?.name ?? '';
  $('setWeekendOff').checked = settings.weekendOff;
  $('setParentMode').checked = settings.parentMode;
  $('setLateTime').value = settings.lateAlertTime;
  renderStageEditor(settings.stages);
  renderShareLinks();
  $('settingsModal').hidden = false;
}

function renderStageEditor(stages) {
  const box = $('stageEditor');
  box.textContent = '';
  for (const s of stages) {
    const row = document.createElement('div');
    row.className = 'stage-edit-row';
    row.dataset.id = s.id;
    row.innerHTML = `
      <input type="time" class="edit-time">
      <input type="text" class="edit-emoji" maxlength="4">
      <input type="text" class="edit-label">
      <label style="font-size:13px"><input type="checkbox" class="edit-check"> 체크</label>
      <button class="edit-del" title="삭제">✕</button>`;
    row.querySelector('.edit-time').value = s.time;
    row.querySelector('.edit-emoji').value = s.emoji;
    row.querySelector('.edit-label').value = s.label;
    row.querySelector('.edit-check').checked = s.check;
    row.querySelector('.edit-del').addEventListener('click', () => row.remove());
    box.append(row);
  }
}

function readStageEditor() {
  const stages = [];
  for (const row of $('stageEditor').querySelectorAll('.stage-edit-row')) {
    const label = row.querySelector('.edit-label').value.trim();
    const time = row.querySelector('.edit-time').value;
    if (!label || !time) continue;
    stages.push({
      id: row.dataset.id || 's' + Math.random().toString(36).slice(2, 8),
      time,
      emoji: row.querySelector('.edit-emoji').value || '⭐',
      label,
      check: row.querySelector('.edit-check').checked,
    });
  }
  stages.sort((a, b) => a.time.localeCompare(b.time));
  return stages;
}

function renderShareLinks() {
  const topic = $('setTopic').value.trim();
  const base = location.origin + location.pathname;
  const box = $('shareLinks');
  box.textContent = '';
  const line = (prefix, boldText) => {
    const div = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = boldText;
    div.append(prefix, b);
    box.append(div);
  };
  if (topic) {
    line('👨 부모 모드: ', `${base}?topic=${encodeURIComponent(topic)}&mode=parent`);
    line('📱 ntfy 앱 구독 토픽: ', topic);
  } else {
    box.textContent = '채널 이름을 먼저 입력하세요';
  }
}

function saveSettingsFromUI() {
  settings.topic = $('setTopic').value.trim();
  settings.kids = [
    { id: 'k1', name: $('setKid1').value.trim() || '첫째' },
    { id: 'k2', name: $('setKid2').value.trim() },
  ];
  settings.weekendOff = $('setWeekendOff').checked;
  settings.parentMode = $('setParentMode').checked;
  settings.lateAlertTime = $('setLateTime').value || '08:35';
  const stages = readStageEditor();
  if (stages.length > 0) settings.stages = stages;
  saveSettings();
  $('settingsModal').hidden = true;
  replayEvents();
  subscribe();
  render();
}

// ---------- 초기화 ----------
function init() {
  $('startOverlay').addEventListener('click', () => {
    ensureAudio(); // iPad Safari: 사용자 제스처 안에서 AudioContext 를 깨워야 소리가 난다
    keepAwake();
    $('startOverlay').hidden = true;
    if (!settings.topic) openSettings(); // 최초 실행: 채널 설정 유도
  });

  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', () => { $('settingsModal').hidden = true; });
  $('settingsSave').addEventListener('click', saveSettingsFromUI);
  $('setTopic').addEventListener('input', renderShareLinks);
  $('addStageBtn').addEventListener('click', () => {
    const stages = readStageEditor();
    stages.push({ id: 's' + Math.random().toString(36).slice(2, 8), time: '08:00', emoji: '⭐', label: '', check: true });
    renderStageEditor(stages);
  });
  $('testPushBtn').addEventListener('click', async () => {
    settings.topic = $('setTopic').value.trim();
    if (!settings.topic) return alert('채널 이름을 먼저 입력하세요');
    const ok = await publishPush('테스트 알림이에요 👋 이게 보이면 연결 성공!');
    alert(ok ? '보냈어요! 아빠 폰 ntfy 앱을 확인하세요' : '전송 실패 — 인터넷 연결을 확인하세요');
  });

  $('sosBtn').addEventListener('click', () => { $('sosConfirm').hidden = false; });
  $('sosNo').addEventListener('click', () => { $('sosConfirm').hidden = true; });
  $('sosYes').addEventListener('click', () => { $('sosConfirm').hidden = true; sendSOS(); });
  $('sosDismiss').addEventListener('click', () => { $('sosBanner').hidden = true; });

  // 화면이 다시 보일 때 wake lock 재획득 (탭 전환·잠금 해제 후 풀리는 사양)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });

  restoreChecks();
  render();
  updateClock();
  setInterval(tick, 1000);

  if (settings.topic) {
    saveSettings(); // URL 파라미터로 받은 topic/mode 를 기기에 고정
    replayEvents();
    subscribe();
  }
}

init();
