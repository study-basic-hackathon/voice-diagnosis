/* =========================================
   lover-app / app.js
   Web Audio API + Web Speech API による音声解析
   ========================================= */

// ---- 画面管理 ----
const screens = {
  top: document.getElementById('screen-top'),
  record: document.getElementById('screen-record'),
  analyzing: document.getElementById('screen-analyzing'),
  result: document.getElementById('screen-result'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  window.scrollTo(0, 0);
}

// ---- 録音関連の状態 ----
let audioContext = null;
let analyser = null;
let mediaStream = null;
let mediaRecorder = null;
let isRecording = false;
let recordStartTime = null;
let timerInterval = null;
let visualizerRAF = null;

// 音声特徴の収集バッファ
let volumeSamples = [];     // dB値の時系列
let silenceStart = null;    // 無音区間の開始時刻
let silenceDurations = [];  // 無音区間の長さリスト（ms）
let lastVolumeTime = null;  // 周期性計算用

// Web Speech API
let speechRecognition = null;
let transcript = '';

// ---- DOM参照 ----
const btnStart      = document.getElementById('btn-start');
const btnRecordStart = document.getElementById('btn-record-start');
const btnRecordStop  = document.getElementById('btn-record-stop');
const btnRetry       = document.getElementById('btn-retry');
const recordTimer    = document.getElementById('record-timer');
const recordError    = document.getElementById('record-error');
const analyzerMsg    = document.getElementById('analyzing-message');
const visualizerCont = document.getElementById('visualizer-container');
const visualizerCanvas = document.getElementById('visualizer');

// ---- ボタンイベント ----
btnStart.addEventListener('click', () => showScreen('record'));

btnRecordStart.addEventListener('click', async () => {
  recordError.textContent = '';
  await startRecording();
});

btnRecordStop.addEventListener('click', () => {
  stopRecording();
});

btnRetry.addEventListener('click', () => {
  resetAll();
  showScreen('top');
});

// ---- 録音開始 ----
async function startRecording() {
  // ブラウザ対応チェック
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('このブラウザはマイク録音に対応していません。Chrome または Safari をお試しください。');
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showError('マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。');
    } else {
      showError('マイクへのアクセスに失敗しました：' + err.message);
    }
    return;
  }

  // Web Audio API セットアップ
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);

  // 収集データ初期化
  volumeSamples = [];
  silenceStart = null;
  silenceDurations = [];
  lastVolumeTime = null;
  transcript = '';

  isRecording = true;
  recordStartTime = Date.now();

  // ボタン状態切り替え
  btnRecordStart.disabled = true;
  btnRecordStart.classList.add('recording');
  btnRecordStop.disabled = false;

  // ビジュアライザー開始
  visualizerCont.classList.add('active');
  drawVisualizer();

  // 音量サンプリング（100msごと）
  startVolumeSampling();

  // タイマー表示
  timerInterval = setInterval(updateTimer, 500);

  // Web Speech API（対応ブラウザのみ）
  startSpeechRecognition();
}

// ---- 録音停止 ----
function stopRecording() {
  if (!isRecording) return;

  const duration = (Date.now() - recordStartTime) / 1000; // 秒

  // 10秒未満は警告
  if (duration < 10) {
    showError('録音が短すぎます。台本全体を読んでから停止してください（目安10秒以上）。');
    return;
  }

  isRecording = false;

  // タイマー・ビジュアライザー停止
  clearInterval(timerInterval);
  cancelAnimationFrame(visualizerRAF);
  visualizerCont.classList.remove('active');

  // マイクストリーム解放
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
  }
  if (audioContext) {
    audioContext.close();
  }

  // 音声認識停止
  if (speechRecognition) {
    try { speechRecognition.stop(); } catch (_) {}
  }

  // ボタン状態戻す
  btnRecordStart.disabled = false;
  btnRecordStart.classList.remove('recording');
  btnRecordStop.disabled = true;

  // 特徴量計算 → 分析へ
  const features = calcSpeechFeatures(duration);
  analyzeAndShowResult(features);
}

// ---- タイマー更新 ----
function updateTimer() {
  if (!recordStartTime) return;
  const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  recordTimer.textContent = `${mm}:${ss}`;
}

// ---- ビジュアライザー描画 ----
function drawVisualizer() {
  if (!isRecording) return;
  visualizerRAF = requestAnimationFrame(drawVisualizer);

  const bufferLen = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLen);
  analyser.getByteFrequencyData(dataArray);

  const canvas = visualizerCanvas;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth;
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  const barCount = 60;
  const barWidth = (W / barCount) - 1;
  const step = Math.floor(bufferLen / barCount);

  for (let i = 0; i < barCount; i++) {
    const value = dataArray[i * step] / 255;
    const barH = value * H;
    const alpha = 0.5 + value * 0.5;
    ctx.fillStyle = `rgba(232, 121, 154, ${alpha})`;
    ctx.fillRect(i * (barWidth + 1), H - barH, barWidth, barH);
  }
}

// ---- 音量サンプリング ----
let samplingInterval = null;
const SILENCE_THRESHOLD_DB = -40; // dB

function startVolumeSampling() {
  samplingInterval = setInterval(() => {
    if (!isRecording || !analyser) return;

    const bufLen = analyser.fftSize;
    const timeData = new Float32Array(bufLen);
    analyser.getFloatTimeDomainData(timeData);

    // RMS → dB
    let sum = 0;
    for (let i = 0; i < bufLen; i++) sum += timeData[i] * timeData[i];
    const rms = Math.sqrt(sum / bufLen);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;

    volumeSamples.push(db);

    // 無音区間検出
    const now = Date.now();
    if (db < SILENCE_THRESHOLD_DB) {
      if (silenceStart === null) silenceStart = now;
    } else {
      if (silenceStart !== null) {
        const dur = now - silenceStart;
        if (dur > 200) silenceDurations.push(dur); // 200ms以上を無音区間としてカウント
        silenceStart = null;
      }
      lastVolumeTime = now;
    }
  }, 100);
}

// ---- 音声特徴の計算 ----
function calcSpeechFeatures(durationSec) {
  clearInterval(samplingInterval);

  // 平均テンポ：句読点・記号を除いた文字数 / 録音時間（秒）
  // 日本語の書き起こしは漢字・ひらがな混じりのため 1文字 ≈ 1mora で計算
  const cleanedTranscript = transcript.replace(/[\s、。！？!?,.，．・「」『』【】（）()]/g, '');
  const moraCount = cleanedTranscript.length;
  const tempo = durationSec > 0 ? moraCount / durationSec : 0;

  // テンポの目安判定
  const tempoLabel = tempo <= 3 ? 'ゆっくり' : tempo >= 5 ? '早口' : '普通';
  console.log('[テンポ計算]', {
    書き起こし全文: transcript,
    句読点除去後: cleanedTranscript,
    文字数_モーラ数: moraCount,
    録音時間_秒: durationSec.toFixed(2),
    テンポ_mora毎秒: tempo.toFixed(2),
    判定: tempoLabel + `（目安：3以下=ゆっくり, 5以上=早口）`,
  });

  // 無音区間
  const silenceCount = silenceDurations.length;
  const silenceAvg = silenceCount > 0
    ? silenceDurations.reduce((a, b) => a + b, 0) / silenceCount
    : 0;

  // 音量統計
  const validSamples = volumeSamples.filter(v => v > -90);
  const volumeMean = validSamples.length > 0
    ? validSamples.reduce((a, b) => a + b, 0) / validSamples.length
    : -60;
  const volumeVariance = validSamples.length > 0
    ? validSamples.reduce((s, v) => s + (v - volumeMean) ** 2, 0) / validSamples.length
    : 0;
  const volumeStdDev = Math.sqrt(volumeVariance);

  // 音量変化の周期性：無音区間の間隔の均一さから計算
  let rhythmScore = 0;
  if (silenceDurations.length >= 2) {
    const mean = silenceAvg;
    const variance = silenceDurations.reduce((s, v) => s + (v - mean) ** 2, 0) / silenceDurations.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1; // 変動係数
    rhythmScore = Math.max(0, 1 - cv); // 均一なほど1に近い
  }

  return {
    tempo: Math.max(0, tempo),
    silenceAvg: Math.max(0, silenceAvg),
    silenceCount,
    volumeMean,
    volumeStdDev,
    rhythmScore,
  };
}

// ---- Web Speech API ----
function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.info('Web Speech API非対応ブラウザ。テキスト変換はスキップします。');
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = 'ja-JP';
  speechRecognition.continuous = true;
  speechRecognition.interimResults = false;

  speechRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
  };

  speechRecognition.onerror = (e) => {
    console.warn('音声認識エラー:', e.error);
    if (e.error === 'no-speech' && isRecording) {
      // 録音中に音声が認識できなかった場合は録音を停止してエラーを通知
      isRecording = false;
      clearInterval(timerInterval);
      cancelAnimationFrame(visualizerRAF);
      visualizerCont.classList.remove('active');
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
      if (audioContext) audioContext.close();
      clearInterval(samplingInterval);
      btnRecordStart.disabled = false;
      btnRecordStart.classList.remove('recording');
      btnRecordStop.disabled = true;
      showError('音声を認識できませんでした。もう少し大きな声でもう一度お試しください。');
    }
  };

  try {
    speechRecognition.start();
  } catch (e) {
    console.warn('音声認識開始失敗:', e);
  }
}

// ---- バックエンドに送信 → 結果表示 ----
async function analyzeAndShowResult(features) {
  showScreen('analyzing');

  // 進捗メッセージの順次表示
  const messages = [
    '声のデータを解析中…',
    '性格の傾向を読み取っています…',
    'あなたに合う相手を探しています…',
    'プロフィールを生成しています…',
  ];
  let msgIdx = 0;
  analyzerMsg.textContent = messages[0];
  const msgInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % messages.length;
    analyzerMsg.textContent = messages[msgIdx];
  }, 2000);

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speechFeatures: features,
        transcript,
      }),
    });

    clearInterval(msgInterval);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `サーバーエラー (${res.status})`);
    }

    const data = await res.json();
    renderResult(data);
    showScreen('result');

  } catch (err) {
    clearInterval(msgInterval);
    showScreen('record');
    showError('エラーが発生しました：' + err.message);
  }
}

// ---- 結果画面の描画 ----
let radarChart = null;

function renderResult(data) {
  const { userBigFive, partnerBigFive, partnerProfile, voiceAnalysis } = data;

  // 声の特徴セクション
  if (voiceAnalysis) {
    document.getElementById('voice-overall').textContent = voiceAnalysis.overall || '—';

    // キーワードバッジ
    const keywordsEl = document.getElementById('voice-keywords');
    keywordsEl.innerHTML = '';
    (voiceAnalysis.keywords || []).forEach(kw => {
      const span = document.createElement('span');
      span.className = 'voice-keyword-badge';
      span.textContent = kw;
      keywordsEl.appendChild(span);
    });

    document.getElementById('voice-speed-label').textContent = voiceAnalysis.speed_label || '—';
    document.getElementById('voice-speed-desc').textContent = voiceAnalysis.speed_description || '—';
    document.getElementById('voice-pause-label').textContent = voiceAnalysis.pause_label || '—';
    document.getElementById('voice-pause-desc').textContent = voiceAnalysis.pause_description || '—';
    document.getElementById('voice-volume-label').textContent = voiceAnalysis.volume_label || '—';
    document.getElementById('voice-volume-desc').textContent = voiceAnalysis.volume_description || '—';
    document.getElementById('voice-rhythm-label').textContent = voiceAnalysis.rhythm_label || '—';
    document.getElementById('voice-rhythm-desc').textContent = voiceAnalysis.rhythm_description || '—';
  }

  // レーダーチャート
  drawRadarChart(userBigFive, partnerBigFive);

  // パートナー基本情報
  document.getElementById('partner-name').textContent = partnerProfile.name || '—';
  document.getElementById('partner-meta').textContent =
    `${partnerProfile.age}歳・${partnerProfile.job}`;
  document.getElementById('partner-catchphrase').textContent =
    `「${partnerProfile.catchphrase}」`;

  // リスト系
  renderList('partner-appearance', partnerProfile.appearance);
  renderList('partner-personality', partnerProfile.personality);
  renderList('partner-hobbies', partnerProfile.hobbies);

  // エピソード
  document.getElementById('partner-meet-story').textContent =
    partnerProfile.meet_story || '—';

  const episodesEl = document.getElementById('partner-episodes');
  episodesEl.innerHTML = '';
  (partnerProfile.episodes || []).forEach(ep => {
    const div = document.createElement('div');
    div.className = 'episode-item';
    div.textContent = ep;
    episodesEl.appendChild(div);
  });
}

function renderList(elementId, items) {
  const el = document.getElementById(elementId);
  el.innerHTML = '';
  (items || []).forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    el.appendChild(li);
  });
}

function drawRadarChart(userBigFive, partnerBigFive) {
  const ctx = document.getElementById('radar-chart').getContext('2d');

  // 既存チャートを破棄
  if (radarChart) {
    radarChart.destroy();
    radarChart = null;
  }

  const labels = ['開放性', '誠実性', '外向性', '協調性', '安定性'];
  const toStability = (n) => 100 - n; // 神経症傾向を反転して「安定性」として表示

  radarChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [
        {
          label: 'あなた',
          data: [
            userBigFive.openness,
            userBigFive.conscientiousness,
            userBigFive.extraversion,
            userBigFive.agreeableness,
            toStability(userBigFive.neuroticism),
          ],
          backgroundColor: 'rgba(232, 121, 154, 0.15)',
          borderColor: 'rgba(232, 121, 154, 0.8)',
          pointBackgroundColor: 'rgba(232, 121, 154, 1)',
          borderWidth: 2,
          pointRadius: 4,
        },
        {
          label: '恋人',
          data: [
            partnerBigFive.openness,
            partnerBigFive.conscientiousness,
            partnerBigFive.extraversion,
            partnerBigFive.agreeableness,
            toStability(partnerBigFive.neuroticism),
          ],
          backgroundColor: 'rgba(201, 160, 220, 0.15)',
          borderColor: 'rgba(201, 160, 220, 0.8)',
          pointBackgroundColor: 'rgba(201, 160, 220, 1)',
          borderWidth: 2,
          pointRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: {
            display: false,
          },
          grid: {
            color: 'rgba(255, 255, 255, 0.08)',
          },
          angleLines: {
            color: 'rgba(255, 255, 255, 0.08)',
          },
          pointLabels: {
            color: '#b0a8c4',
            font: { size: 13 },
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: '#b0a8c4',
            font: { size: 12 },
          },
        },
      },
    },
  });
}

// ---- エラー表示 ----
function showError(msg) {
  recordError.textContent = msg;
}

// ---- リセット ----
function resetAll() {
  isRecording = false;
  transcript = '';
  volumeSamples = [];
  silenceDurations = [];
  silenceStart = null;
  recordTimer.textContent = '00:00';
  recordError.textContent = '';
  btnRecordStart.disabled = false;
  btnRecordStart.classList.remove('recording');
  btnRecordStop.disabled = true;
  visualizerCont.classList.remove('active');
  clearInterval(timerInterval);
  clearInterval(samplingInterval);
  cancelAnimationFrame(visualizerRAF);
}
