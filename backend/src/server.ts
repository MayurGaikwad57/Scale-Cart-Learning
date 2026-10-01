import { createApp } from "./app.js";
import { env } from "./config/env.js";

createApp().listen(env.PORT, () => {
  console.log(`ScaleCart API listening on :${env.PORT}`);
});
