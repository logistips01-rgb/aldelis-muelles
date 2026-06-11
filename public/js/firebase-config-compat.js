const firebaseConfig = {
  apiKey: "AIzaSyA36_n5fU8L6dvc3qJem4o6yGQ4hsiE6ug",
  authDomain: "aldelis-muelles.firebaseapp.com",
  projectId: "aldelis-muelles",
  storageBucket: "aldelis-muelles.firebasestorage.app",
  messagingSenderId: "845448565876",
  appId: "1:845448565876:web:e347390b385218adc6ed21"
};

firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();
