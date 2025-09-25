const { Queue, QueueScheduler } = require("bullmq");

const emailQueue = new Queue("email", {
  connection: { url: process.env.REDIS_URL },
});

(async () => {
  // Remove waiting + delayed
  await emailQueue.drain(true); // true = remove even delayed

  // Remove completed + failed
  await emailQueue.clean(0, 1000, "completed");
  await emailQueue.clean(0, 1000, "failed");

  console.log("✅ All jobs cleared from queue");
})();
