// routes/schedule.js
import { Router } from "express";

const router = Router();

// 範例：排程列表
router.get("/", (req, res) => {
  res.json({ message: "📅 Schedule route is working!" });
});

export default router;
