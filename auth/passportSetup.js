import passport from "passport";
// TODO: 在這裡設定你的策略，例如 Apple、Google、Local

// 這裡是一個範例（暫時的 placeholder），避免 Render 無法編譯：
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});
