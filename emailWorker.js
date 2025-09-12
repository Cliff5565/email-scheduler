// workers/emailWorker.js
import { Worker } from "bullmq";
import { transporter } from "../server.js";

const worker = new Worker(
  "emails",
  async (job) => {
    const { to, subject, body } = job.data;
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      text: body,
    });
    console.log(`✅ Email sent to ${to}`);
  },
  {
    connection: {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: process.env.REDIS_PORT || 6379,
    },
  }
);

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err);
});
