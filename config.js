// ============================================================
//  EcoSense Duo — сайт баптаулары (тек осы файлды өзгертесіз)
// ============================================================
window.ECOSENSE_CONFIG = {
  // Деректер қайдан алынады:
  //   "mysql"    — өз хостингіңіздегі база (api/ папкасы, hoster.kz)   ← негізгі
  //   "firebase" — Firebase Realtime Database
  //   "demo"     — жасанды деректер (дизайнды көрсету үшін)
  backend: "firebase",
  apiUrl: "api/",            // PHP API папкасы (сайтпен бір доменде)

  firebase: {
    apiKey: "AIzaSyCeHsQ10P6ae2VEGxnqgY-wvQGTxG_xZRI",
    authDomain: "ecosense-duo.firebaseapp.com",
    databaseURL: "https://ecosense-duo-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "ecosense-duo",
    appId: "1:281451273867:web:2c3b04418ca97d8533be8e"
  },

  // Құрылғы тұрған жердің / су көзінің аты (ESP32 жібермесе, осы көрсетіледі)
  places: {
    smokeoff: "Астана қ., мектеп ауласы",
    aquascan: "Есіл өзені"
  },

  // Норма шектері: одан асса — сары, одан да асса — қызыл
  thresholds: {
    co2:       { good: 800, warn: 1200 },   // ppm
    turbidity: { good: 50,  warn: 150  },   // NTU (лайлылық)
    ph:        { min: 6.5, max: 8.5, warnMin: 6.0, warnMax: 9.0 }
  },

  // Құрылғы осыдан ұзақ дерек жібермесе — "Офлайн" (минут)
  offlineAfterMin: 3,

  // Команда беті
  team: [
    { name: "Amina", role: "Жоба авторы" },
    { name: "Aisha", role: "Жоба авторы" }
    // { name: "Аты-жөні", role: "Ғылыми жетекші" },
  ],
  school: "ITECX"
};
