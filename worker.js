import { Worker } from "bullmq";
import { transporter } from "./server.js"; // Adjust path
import IORedis from "ioredis";

const queue = new Queue("emails", {
  connection: new IORedis(process.env.REDIS_URL),
});

const worker = new Worker(
  "emails",
  async (job) => {
    const { to, subject, body } = job.data;
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text: body });
    console.log(`✅ Sent email to ${to}`);
  },
  { connection: queue.connection }
);

worker.on("error", (err) => console.error("Worker error:", err));
