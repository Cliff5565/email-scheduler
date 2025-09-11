import express from "express";
import nodemailer from "nodemailer";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const port = process.env.PORT || 10000;

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(dirname, "schedule.html"));
});

app.post("/schedule", (req, res) => {
  const { to, subject, message, scheduleTime } = req.body;

  if (!to || !subject || !message || !scheduleTime) {
    return res.status(400).json({ error: "❌ Missing required fields" });
  }

  const runAt = new Date(scheduleTime);
  if (isNaN(runAt.getTime())) {
    return res.status(400).json({ error: "❌ Invalid date/time format" });
  }

  const minute = runAt.getMinutes();
  const hour = runAt.getHours();
  const day = runAt.getDate();
  const month = runAt.getMonth() + 1;
  const cronExp = `${minute} ${hour} ${day} ${month} *`;
  console.log(`📅 Scheduling ${to} at ${runAt} (${cronExp})`);

  cron.schedule(cronExp, async () => {
    try {
      await sendEmail(to, subject, message);
      console.log(`✅ Email sent to ${to} at ${new Date().toISOString()}`);
    } catch (err) {
      console.error("❌ Failed to send email:", err);
    }
  });

  res.json({ message: `✅ Email scheduled for ${runAt.toString()}` });
});

async function sendEmail(to, subject, text) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  return transporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject,
    text,
  });
}

app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${port}`);
});
