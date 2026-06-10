importScripts('https://www.gstatic.com/firebasejs/10.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAXCwSRQiIr4otv6I3kJVz7IzdgvV8yxxA",
  authDomain: "worklife-bordado.firebaseapp.com",
  projectId: "worklife-bordado",
  storageBucket: "worklife-bordado.firebasestorage.app",
  messagingSenderId: "840101288164",
  appId: "1:840101288164:web:b32fdc44e9c239f16974f1"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: '/logo192.png'
  });
});