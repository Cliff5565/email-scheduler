import express from "express";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Queue } from "bullmq";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import IORedis from "ioredis"; // added for Redis

dotenv.config();

// Fix __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- Database ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------- Redis ----------
let emailQueue = null;

if (process.env.REDIS_URL) {
  try {
    const connection = new IORedis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
    });
    emailQueue = new Queue("emails", { connection });
    console.log("✅ Connected to Redis and BullMQ queue ready");
  } catch (err) {
    console.error("❌ Failed to connect to Redis:", err.message);
  }
} else {
  console.warn("⚠️ No REDIS_URL set. Queue is disabled.");
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Serve static ----------
app.use(express.static(__dirname));

// ---------- Models ----------
const EmailJobSchema = new mongoose.Schema({
  to: String,
  subject: String,
  body: String,
  datetime: Date,
  status: { type: String, default: "scheduled" },
});
const EmailJob = mongoose.model("EmailJob", EmailJobSchema);

// ---------- Routes ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/schedule", (req, res) => res.sendFile(path.join(__dirname, "schedule.html")));

app.post("/schedule", async (req, res) => {
  const { to, subject, body, datetime } = req.body;
  try {
    const job = await EmailJob.create({ to, subject, body, datetime });

    if (emailQueue) {
      await emailQueue.add(
        "sendEmail",
        { to, subject, body },
        { delay: new Date(datetime).getTime() - Date.now() }
      );
    } else {
      console.warn("⚠️ Queue is disabled, job not added to Redis");
    }

    res.send(`✅ Email scheduled for ${datetime}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Failed to schedule email");
  }
});

// ---------- Nodemailer Transport ----------
export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
