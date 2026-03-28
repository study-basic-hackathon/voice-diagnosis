require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MOCK_MODE = process.env.MOCK_MODE === 'true';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Anthropic クライアント（モックモード時は不使用）
const anthropic = MOCK_MODE ? null : new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---- シード付き疑似乱数生成（mulberry32） ----
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- シード値の計算（CLAUDE.md の重み付け式） ----
function calcSeed(bigFive) {
  const { openness, conscientiousness, extraversion, agreeableness, neuroticism } = bigFive;
  const raw =
    openness * 0.3 +
    conscientiousness * 0.25 +
    extraversion * 0.2 +
    agreeableness * 0.15 +
    neuroticism * 0.1;
  return Math.round(raw * 10) / 10; // 小数第1位で丸め
}

// ---- 相手の性格スコアを決定論的に算出 ----
function calcPartnerBigFive(userBigFive, seed) {
  const rand = mulberry32(Math.floor(seed * 100));

  // 協調性・誠実性 → 類似性（±10の範囲でランダム変動）
  const agreeablenessPartner = Math.min(100, Math.max(0,
    userBigFive.agreeableness + (rand() * 20 - 10)
  ));
  const conscientiousnessPartner = Math.min(100, Math.max(0,
    userBigFive.conscientiousness + (rand() * 20 - 10)
  ));

  // 外向性・開放性 → 相補性（100 - ユーザー値 に ±15 の変動）
  const extraversionPartner = Math.min(100, Math.max(0,
    (100 - userBigFive.extraversion) + (rand() * 30 - 15)
  ));
  const opennessPartner = Math.min(100, Math.max(0,
    (100 - userBigFive.openness) + (rand() * 30 - 15)
  ));

  // 神経症傾向 → 低い方が安定、上限60に補正
  const neuroticismPartner = Math.min(60, Math.max(0,
    rand() * 50 // 0〜50 の範囲で生成
  ));

  return {
    openness: Math.round(opennessPartner),
    conscientiousness: Math.round(conscientiousnessPartner),
    extraversion: Math.round(extraversionPartner),
    agreeableness: Math.round(agreeablenessPartner),
    neuroticism: Math.round(neuroticismPartner),
  };
}

// ---- Claude API 呼び出し（529 overloaded_error 時に3秒待って最大3回リトライ） ----
async function callClaudeWithRetry(params, maxRetries = 3, retryDelay = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      const isOverloaded = err.status === 529 ||
        (err.error && err.error.type === 'overloaded_error');
      if (isOverloaded && attempt < maxRetries) {
        console.warn(`Claude API 過負荷（試行 ${attempt}/${maxRetries}）。${retryDelay / 1000}秒後にリトライします...`);
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        throw err;
      }
    }
  }
}

// ---- Claude APIレスポンスのJSONパース ----
function parseClaudeJson(text) {
  // ```json ``` を除去
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  // 前後の空白を除去
  cleaned = cleaned.trim();
  // { または [ で始まる部分を探す
  const jsonStart = cleaned.search(/[\[{]/);
  if (jsonStart > 0) {
    cleaned = cleaned.slice(jsonStart);
  }
  // 最後の } または ] を探す
  const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastBrace !== -1) {
    cleaned = cleaned.slice(0, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ---- Claude API でビッグファイブを算出 ----
async function analyzeBigFive(speechFeatures, transcript) {
  const prompt = `以下は、ある人が台本を読み上げた際の音声特徴データと書き起こしテキストです。
これらのデータをもとに、その人のビッグファイブ性格特性を 0〜100 のスコアで推定してください。

【音声特徴データ】
- 平均テンポ: ${speechFeatures.tempo.toFixed(2)} mora/秒
- 無音区間の平均長さ: ${speechFeatures.silenceAvg.toFixed(0)} ms
- 無音区間の回数: ${speechFeatures.silenceCount} 回
- 音量の標準偏差: ${speechFeatures.volumeStdDev.toFixed(2)} dB
- 音量の平均値: ${speechFeatures.volumeMean.toFixed(2)} dB
- 音量変化の周期性スコア: ${speechFeatures.rhythmScore.toFixed(2)}

【書き起こしテキスト】
${transcript || '（取得できませんでした）'}

【スコア算出のヒント】
- テンポが速い・無音区間が少ない → 外向性（extraversion）高め
- 抑揚が大きい（音量標準偏差が高い）→ 開放性（openness）高め
- 音量が安定・間が規則的（周期性高い）→ 誠実性（conscientiousness）高め
- 声が小さい・間が多い → 感受性の豊かさ・繊細さ（neuroticism）高め
- 読み飛ばしが少ない（書き起こしが台本に近い）→ 誠実性高め

以下のJSON形式のみで返答してください（説明文は不要）：
{
  "openness": <0-100の整数>,
  "conscientiousness": <0-100の整数>,
  "extraversion": <0-100の整数>,
  "agreeableness": <0-100の整数>,
  "neuroticism": <0-100の整数>
}`;

  const message = await callClaudeWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  return parseClaudeJson(text);
}

// ---- Claude API で恋人プロフィールを生成 ----
async function generatePartnerProfile(partnerBigFive, seed, partnerGender) {
  const genderMap = { male: '男性', female: '女性', any: null };
  const genderInstruction = genderMap[partnerGender]
    ? `恋人は必ず${genderMap[partnerGender]}にしてください。`
    : '恋人の性別は自由に設定してください。';

  const prompt = `以下は、ある人の性格特性スコア（ビッグファイブ）です。
この性格を持つ理想の恋人のプロフィールを生成してください。

【重要】${genderInstruction}

【相手の性格スコア】
- 新しいものへの好奇心（openness）: ${partnerBigFive.openness}
- まじめさ・几帳面さ（conscientiousness）: ${partnerBigFive.conscientiousness}
- 社交的なエネルギー（extraversion）: ${partnerBigFive.extraversion}
- 思いやり・協調性（agreeableness）: ${partnerBigFive.agreeableness}
- 感受性の豊かさ・繊細さ（neuroticism）: ${partnerBigFive.neuroticism}

魅力的でリアルな人物像を作成し、以下のJSON形式のみで返答してください（説明文は不要）：
{
  "name": "名前（日本人の名前、ひらがな・漢字）",
  "age": <20-35の整数>,
  "job": "職業（具体的に）",
  "appearance": ["見た目の特徴1", "見た目の特徴2", "見た目の特徴3"],
  "personality": ["性格の特徴1", "性格の特徴2", "性格の特徴3"],
  "catchphrase": "口癖や口ぐせになってる言葉",
  "hobbies": ["趣味1", "趣味2", "趣味3"],
  "meet_story": "出会いのエピソード（2〜3文）",
  "episodes": ["あるあるエピソード1", "あるあるエピソード2", "あるあるエピソード3"]
}`;

  const message = await callClaudeWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    temperature: 0.3, // 再現性のため低め
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  return parseClaudeJson(text);
}

// ---- Claude API で声の特徴を分析 ----
async function generateVoiceAnalysis(speechFeatures, userBigFive) {
  const prompt = `以下は、ある人が台本を読み上げた際の音声特徴データとビッグファイブスコアです。
この人の「話し方の特徴」を、具体的・個性的に分析してください。

【音声特徴データ（参考値）】
- 平均テンポ: ${speechFeatures.tempo.toFixed(2)} mora/秒
- 無音区間の平均長さ: ${speechFeatures.silenceAvg.toFixed(0)} ms
- 無音区間の回数: ${speechFeatures.silenceCount} 回
- 音量の標準偏差: ${speechFeatures.volumeStdDev.toFixed(2)} dB
- 音量の平均値: ${speechFeatures.volumeMean.toFixed(2)} dB
- 音量変化の周期性スコア: ${speechFeatures.rhythmScore.toFixed(2)}

【ビッグファイブスコア】
- 新しいものへの好奇心: ${userBigFive.openness}
- まじめさ・几帳面さ: ${userBigFive.conscientiousness}
- 社交的なエネルギー: ${userBigFive.extraversion}
- 思いやり・協調性: ${userBigFive.agreeableness}
- 感受性の豊かさ・繊細さ: ${userBigFive.neuroticism}

【出力の方針】
- 数値（ms・dB・mora/秒など）はそのまま使わず、「少し長め」「ゆっくり」「しっかり」などの感覚的な言葉に変換すること
- 専門用語を使わず、友達に話しかけるような親しみやすい口語表現にすること
- ポジティブで温かいトーンにすること
- 読んで「わかる！」と思えるような表現を心がけること

以下のJSON形式のみで返答してください（説明文は不要）：
{
  "overall": "この人の話し方の全体的な印象（2〜3文、親しみやすい言葉でその人らしく描写）",
  "speed_label": "話すスピードを表す一言（例：ゆっくり丁寧 / テキパキ元気 / など）",
  "speed_description": "話すスピードの特徴と、それが聞いている人にどう伝わるかを友達に話すような口調で",
  "pause_label": "間の使い方を表す一言（例：間を大切にする / 自然な間 / テンポよく など）",
  "pause_description": "間の使い方の特徴と印象を友達に話すような口調で",
  "volume_label": "声の大きさを表す一言（例：穏やかな声量 / しっかりした声 / など）",
  "volume_description": "声の大きさの特徴と印象を友達に話すような口調で",
  "rhythm_label": "抑揚・リズムを表す一言（例：抑揚豊か / 落ち着いたトーン / など）",
  "rhythm_description": "抑揚やリズムの特徴と印象を友達に話すような口調で",
  "keywords": ["この人の話し方を表すキーワード1", "キーワード2", "キーワード3"]
}`;

  const message = await callClaudeWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  console.log('[generateVoiceAnalysis] Claude raw response:', text);
  return parseClaudeJson(text);
}

// ---- モックデータ ----
function getMockBigFive() {
  return {
    openness: 72,
    conscientiousness: 65,
    extraversion: 55,
    agreeableness: 78,
    neuroticism: 30,
  };
}

function getMockVoiceAnalysis() {
  return {
    overall: 'ゆったりとしたペースで、言葉をひとつひとつ丁寧に紡ぐような話し方です。聞いている人が自然と安心感を覚える、穏やかな声の持ち主です。',
    speed_label: 'ゆっくり丁寧',
    speed_description: 'せかせかせず、相手が理解する時間を自然に作りながら話せる人という印象を与えます。',
    pause_label: '間を大切にする',
    pause_description: '言葉と言葉の間にゆとりがあり、考えながら話していることが伝わります。',
    volume_label: '穏やかな声量',
    volume_description: '大声で圧迫感を与えることなく、近い距離で話すのが心地よい声の大きさです。',
    rhythm_label: '落ち着いたトーン',
    rhythm_description: '音量の起伏が少なく、安定したリズムで話すため、聴き疲れしない話し方です。',
    keywords: ['落ち着いた', '丁寧', '聞き心地がいい'],
  };
}

function getMockProfile() {
  return {
    name: '田中 葵',
    age: 26,
    job: 'グラフィックデザイナー',
    appearance: ['柔らかい茶色のショートヘア', '少し大きめの瞳が印象的', 'いつもシンプルで清潔感のある服装'],
    personality: ['聞き上手で相手の話に深く共感する', '好奇心旺盛で新しいことにすぐ飛びつく', '感情表現が豊かで笑顔が絶えない'],
    catchphrase: 'なるほど、たしかに〜',
    hobbies: ['カフェ巡り', '映画鑑賞', '水彩画'],
    meet_story: '共通の友人の誕生日パーティーで隣になり、好きな映画の話で盛り上がって連絡先を交換しました。その後、二人で観に行った映画のエンディングで思わず目が合って、そこから急接近しました。',
    episodes: [
      'デートの待ち合わせに必ず5分早く来て「待ってたよ〜」と笑顔で言う',
      '好きな映画のセリフをさりげなく日常会話に混ぜてくる',
      '悩んでいると「一緒に美味しいもの食べに行こう」と必ず誘ってくれる',
    ],
  };
}

// ---- メインAPIエンドポイント ----
app.post('/api/analyze', async (req, res) => {
  try {
    const { speechFeatures, transcript, partnerGender = 'female' } = req.body;

    // 入力バリデーション
    if (!speechFeatures) {
      return res.status(400).json({ error: '音声特徴データが見つかりません' });
    }

    const validGenders = ['male', 'female', 'any'];
    const safePartnerGender = validGenders.includes(partnerGender) ? partnerGender : 'female';

    let userBigFive, partnerProfile, partnerBigFive, seed;

    let voiceAnalysis;

    if (MOCK_MODE) {
      // モックモード：ダミーデータで返す
      await new Promise(r => setTimeout(r, 1500)); // 疑似ローディング
      userBigFive = getMockBigFive();
      seed = calcSeed(userBigFive);
      partnerBigFive = calcPartnerBigFive(userBigFive, seed);
      partnerProfile = getMockProfile();
      voiceAnalysis = getMockVoiceAnalysis();
    } else {
      // Step 1: ビッグファイブ算出
      userBigFive = await analyzeBigFive(speechFeatures, transcript);

      // Step 2: シード生成
      seed = calcSeed(userBigFive);

      // Step 3: 相手のビッグファイブを決定論的に算出
      partnerBigFive = calcPartnerBigFive(userBigFive, seed);

      // Step 4: 恋人プロフィール生成・声の特徴分析（並列実行）
      [partnerProfile, voiceAnalysis] = await Promise.all([
        generatePartnerProfile(partnerBigFive, seed, safePartnerGender),
        generateVoiceAnalysis(speechFeatures, userBigFive),
      ]);
    }

    res.json({
      userBigFive,
      partnerBigFive,
      partnerProfile,
      voiceAnalysis,
      seed,
    });
  } catch (err) {
    console.error('APIエラー:', err);
    res.status(500).json({ error: 'サーバーエラーが発生しました。しばらく待ってから再度お試しください。' });
  }
});

app.listen(PORT, () => {
  console.log(`サーバー起動中: http://localhost:${PORT}`);
  console.log(`モックモード: ${MOCK_MODE ? 'ON' : 'OFF'}`);
});
