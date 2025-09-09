// routes/auth.js
import { Router } from "express";

const router = Router();

// 範例：登入路由
router.get("/login", (req, res) => {
  res.json({ message: "🔑 Auth route is working!" });
});

// 你之後可以在這裡加 OAuth2 / Apple / Google 等 Passport 驗證邏輯
export default router;
