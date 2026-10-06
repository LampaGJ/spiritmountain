import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('index.html is missing the #app element');
}

const renderer = new WebGLRenderer({ antialias: true });
renderer.setSize(app.clientWidth, app.clientHeight);
app.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(60, app.clientWidth / app.clientHeight, 0.1, 1000);
camera.position.set(0, 0, 5);

renderer.render(scene, camera);
