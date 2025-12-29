// Simple Express backend for Quiz + Supabase (Postgres)
// Folder: /be

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// DATABASE_URL should be your Supabase Postgres connection string
// Example:
// postgresql://postgres.qemeeyoquxntoftjbmdv:YOUR_PASSWORD@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres
const DATABASE_URL = process.env.DATABASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!DATABASE_URL) {
  console.warn(
    "DATABASE_URL is not set. Please put your Supabase Postgres url in /be/.env"
  );
}

let aiClient = null;
if (!GEMINI_API_KEY) {
  console.warn(
    "GEMINI_API_KEY is not set. Gemini-based feedback will be disabled until you add it to /be/.env"
  );
} else {
  aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ===== Health Check =====
app.all("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ===== Auth =====
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const result = await query(
      "INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at",
      [email, password]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error("register error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await query(
      "SELECT id, email, password, created_at FROM users WHERE email = $1",
      [email]
    );
    if (!result.rows.length || result.rows[0].password !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const user = result.rows[0];
    delete user.password;
    res.json({ user });
  } catch (err) {
    console.error("login error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== Quiz sets (orders) & questions =====

// Import one JSON array as a quiz set
app.post("/api/quiz-sets/import-json", async (req, res) => {
  const { userId, title, questions } = req.body;
  if (!userId || !Array.isArray(questions) || !questions.length) {
    return res
      .status(400)
      .json({ error: "userId and non-empty questions[] are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const quizSetRes = await client.query(
      "INSERT INTO quiz_sets (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at",
      [userId, title || "Imported Quiz"]
    );
    const quizSet = quizSetRes.rows[0];

    const insertQ =
      "INSERT INTO questions (quiz_set_id, question, correct_answer, wrong_answers) VALUES ($1, $2, $3, $4)";

    for (const q of questions) {
      const { question, correctAnswer, wrongAnswers } = q;
      if (!question || !correctAnswer || !Array.isArray(wrongAnswers)) continue;
      await client.query(insertQ, [
        quizSet.id,
        question,
        correctAnswer,
        JSON.stringify(wrongAnswers)
      ]);
    }

    await client.query("COMMIT");
    res.status(201).json({ quizSet });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("import-json error", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// List quiz sets for user
app.get("/api/quiz-sets", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  try {
    const result = await query(
      "SELECT id, title, created_at FROM quiz_sets WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    res.json({ quizSets: result.rows });
  } catch (err) {
    console.error("list quiz-sets error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get questions of a quiz set
app.get("/api/quiz-sets/:id/questions", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query(
      'SELECT id, question, correct_answer AS "correctAnswer", wrong_answers AS "wrongAnswers" FROM questions WHERE quiz_set_id = $1 ORDER BY id',
      [id]
    );
    res.json({ questions: result.rows });
  } catch (err) {
    console.error("get questions error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update quiz set title
app.put("/api/quiz-sets/:id", async (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }
  try {
    await query("UPDATE quiz_sets SET title = $1 WHERE id = $2", [title, id]);
    res.status(204).send();
  } catch (err) {
    console.error("update quiz-set error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete whole quiz set
app.delete("/api/quiz-sets/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await query("DELETE FROM quiz_sets WHERE id = $1", [id]);
    res.status(204).send();
  } catch (err) {
    console.error("delete quiz-set error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update single question
app.put("/api/questions/:id", async (req, res) => {
  const { id } = req.params;
  const { question, correctAnswer, wrongAnswers } = req.body;
  if (!question || !correctAnswer || !Array.isArray(wrongAnswers)) {
    return res
      .status(400)
      .json({ error: "question, correctAnswer, wrongAnswers[] required" });
  }
  try {
    await query(
      "UPDATE questions SET question = $1, correct_answer = $2, wrong_answers = $3 WHERE id = $4",
      [question, correctAnswer, JSON.stringify(wrongAnswers), id]
    );
    res.status(204).send();
  } catch (err) {
    console.error("update question error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete single question
app.delete("/api/questions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await query("DELETE FROM questions WHERE id = $1", [id]);
    res.status(204).send();
  } catch (err) {
    console.error("delete question error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== Gemini feedback for quiz results =====
app.post("/api/quiz-feedback", async (req, res) => {
  if (!aiClient) {
    return res.status(503).json({
      error:
        "Gemini feedback is not configured. Please set GEMINI_API_KEY in /be/.env."
    });
  }

  const { questions, answers } = req.body;
  if (!Array.isArray(questions) || !Array.isArray(answers)) {
    return res
      .status(400)
      .json({ error: "questions[] and answers[] are required arrays" });
  }

  try {
    const items = questions
      .map((q, idx) => {
        const userAnswer =
          idx < answers.length && answers[idx] != null ? answers[idx] : "Không trả lời";
        return `Câu ${idx + 1}:\n- Câu hỏi: ${q.question}\n- Đáp án đúng: ${q.correctAnswer
          }\n- Đáp án user chọn: ${userAnswer}`;
      })
      .join("\n\n");

    const prompt = `Bạn là giáo viên tiếng Anh. Hãy CHẤM ĐIỂM và GIẢI THÍCH ngắn gọn, dễ hiểu cho học viên.

Thông tin bài làm (câu hỏi, đáp án đúng, đáp án user chọn):
${items}

Yêu cầu xuất HTML:
- Viết bằng tiếng Việt.
- TRẢ VỀ DUY NHẤT một đoạn HTML, KHÔNG dùng markdown, KHÔNG dùng \` \`\`\` \`.
- Cấu trúc HTML cần giống ví dụ này (chỉ là ví dụ, nội dung tự thay bằng dữ liệu thật):
  <div class="quiz-feedback">
    <p class="summary">Kết quả: bạn đúng 8 / 10 câu.</p>
    <div class="questions">
      <div class="question">
        <p class="question-title">Câu 1: [nội dung câu hỏi]</p>
        <p class="question-status correct">Đúng</p>
        <p class="question-user-answer"><strong>Em chọn:</strong> [đáp án user chọn]</p>
        <p class="question-correct-answer"><strong>Đáp án đúng:</strong> [đáp án đúng]</p>
        <p class="question-explanation">[Giải thích ngắn gọn vì sao đáp án đúng là đúng, và nếu em sai thì sai chỗ nào]</p>
      </div>
      <!-- lặp lại cho các câu tiếp theo -->
    </div>
  </div>
- class "correct" dùng cho câu đúng, class "wrong" dùng cho câu sai (question-status wrong).
- Hãy đi lần lượt từng câu theo thứ tự từ Câu 1, Câu 2, ... và thay dữ liệu thật vào đúng chỗ.
- Kết quả tổng (bạn đúng X / N câu) phải dựa trên việc so sánh đáp án user chọn với đáp án đúng.

Chỉ trả về HTML (không thêm chú thích ngoài HTML).`;

    // Retry 1–4 lần nếu model bị quá tải (503)
    const maxRetries = 4;
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await aiClient.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt
        });
        const text = response.text || "";
        return res.json({ feedback: text });
      } catch (err) {
        lastError = err;
        // Nếu là lỗi 503 (model overloaded) thì chờ 1 chút rồi thử lại
        const status = err?.status || err?.error?.status;
        if (status === 503 && attempt < maxRetries - 1) {
          const delayMs = 500 * (attempt + 1);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        // Các lỗi khác hoặc hết số lần retry thì ném ra ngoài
        throw err;
      }
    }
    throw lastError;
  } catch (err) {
    console.error("quiz-feedback error", err);
    res.status(500).json({ error: "Failed to generate feedback" });
  }
});

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0'; // Railway requires binding to 0.0.0.0

app.listen(PORT, HOST, () => {
  console.log(`Backend listening on http://${HOST}:${PORT}`);
});


