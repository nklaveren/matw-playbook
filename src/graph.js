import {
  Scene, PerspectiveCamera, WebGLRenderer, Group, Color, FogExp2,
  AmbientLight, PointLight, SphereGeometry, MeshStandardMaterial, Mesh,
  TorusGeometry, MeshBasicMaterial, BufferGeometry, Float32BufferAttribute,
  LineBasicMaterial, Line, Points, PointsMaterial, Vector2, Vector3,
  Raycaster, CanvasTexture, SpriteMaterial, Sprite, AdditiveBlending
} from 'three';

export function mountGraph(host, { topics, questions, onTopic, onQuestion, onHome, getReadingArea, onFrame }) {
  const canvas = host.querySelector('canvas');
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    host.dataset.webgl = 'fallback';
    host.querySelector('.graph-status').textContent = 'Explore the topics using the buttons below.';
    return { selectTopic() {}, questionSide() { return 'left'; }, focusQuestion() {}, focusHome() {}, reframe() {}, reset() {}, zoom() {}, dispose() {} };
  }
  host.dataset.engine = 'threejs';
  host.dataset.webgl = 'ready';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  const scene = new Scene();
  const READING_ZOOM = 2.6;
  scene.fog = new FogExp2('#07151c', 0.024);
  const camera = new PerspectiveCamera(43, 1, 0.1, 100);
  const world = new Group();
  scene.add(world, new AmbientLight('#a9d5db', 2.1));
  const tealLight = new PointLight('#71ffe1', 80, 35);
  tealLight.position.set(-5, 6, 8);
  const roseLight = new PointLight('#ffb2d1', 65, 35);
  roseLight.position.set(6, -3, 7);
  scene.add(tealLight, roseLight);
  const sphere = new SphereGeometry(1, 30, 24);
  const pickables = [], nodes = [], edges = [], labels = [];
  let selected = '', hovered = null, activeQuestion = null, width = 1, height = 1, mobile = false;
  let yaw = 0, pitch = 0, zoom = 1, targetZoom = 1, drag = null, disposed = false;
  const focus = new Vector3(), targetFocus = new Vector3();
  let previousTime = 0;
  let frame = 0, raf = 0, visible = true;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const projected = new Vector3();
  const tooltip = host.querySelector('.graph-tooltip');
  const labelLayer = host.querySelector('.graph-labels');
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 64;
  const ctx = glowCanvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,.65)');
  gradient.addColorStop(0.22, 'rgba(255,255,255,.2)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const glowTexture = new CanvasTexture(glowCanvas);
  const palette = ['#bba5ee', '#e7a8ba', '#9bdacb', '#b49ad5', '#e3bb9b', '#73d8c9', '#caa9cd'];
  const widePositions = [[-5.8, 2.7, 0], [-1.7, 4.4, -2], [4.6, 3.5, -1], [6, -.8, 1], [2.4, -3.9, -1], [-3.1, -3.5, 1.4], [-6.1, -.8, -2]];
  const narrowPositions = [[-3.2, 5, 0], [0, 7, -2], [3.2, 5, -1], [3.6, -1, .8], [1.9, -6, -1], [-1.9, -6, .6], [-3.6, -1, -1.5]];

  function addNode(kind, id, label, radius, color, topic) {
    const material = new MeshStandardMaterial({ color, metalness: .46, roughness: .27, emissive: color, emissiveIntensity: .17 });
    const mesh = new Mesh(sphere, material);
    mesh.scale.setScalar(radius);
    mesh.userData = { kind, id, label, radius, color, topic };
    const glow = new Sprite(new SpriteMaterial({ map: glowTexture, color, transparent: true, blending: AdditiveBlending, depthWrite: false, opacity: .3 }));
    glow.scale.setScalar(radius * 6);
    mesh.add(glow);
    world.add(mesh);
    pickables.push(mesh);
    nodes.push(mesh);
    return mesh;
  }
  function addLabel(mesh, text, callback, isCenter = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-label' + (isCenter ? ' map-label-center' : '');
    button.textContent = text;
    button.dataset.topic = mesh.userData.topic || 'home';
    button.setAttribute('aria-label', isCenter ? 'Reset the competency map' : `Explore ${text}`);
    if (!isCenter) button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', callback);
    button.addEventListener('focus', () => highlight(mesh));
    button.addEventListener('blur', () => highlight(null));
    labelLayer.appendChild(button);
    labels.push({ mesh, button, isCenter });
  }
  function addEdge(a, b, emphasis = false) {
    const geometry = new BufferGeometry().setFromPoints([a.position, b.position]);
    const line = new Line(geometry, new LineBasicMaterial({ color: emphasis ? '#c3c99f' : '#78c7bc', transparent: true, opacity: emphasis ? .25 : .14 }));
    world.add(line);
    edges.push({ a, b, line });
  }
  const center = addNode('home', 'home', 'Nicolas · human in the loop', .48, '#dfc78e');
  addLabel(center, 'NICOLAS', () => activate(center), true);
  for (let i = 0; i < 2; i++) {
    const ring = new Mesh(new TorusGeometry(.7 + i * .13, .009, 8, 90), new MeshBasicMaterial({ color: '#b9a477', transparent: true, opacity: .48 }));
    ring.rotation.x = i ? .7 : -.6;
    ring.rotation.y = i ? -.6 : .6;
    world.add(ring);
  }
  const branches = topics.map((topic, i) => {
    const mesh = addNode('topic', topic.id, topic.label, .26, palette[i], topic.id);
    addLabel(mesh, topic.label, () => activate(mesh));
    const leaves = questions.filter(q => q.cat === topic.id).map((q, j) => {
      const leaf = addNode('question', q.id, q.q, .105, palette[i], topic.id);
      leaf.userData.index = j;
      leaf.userData.count = questions.filter(other => other.cat === topic.id).length;
      const hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'map-question-hit';
      hit.dataset.question = String(q.id);
      hit.setAttribute('aria-label', `Question ${q.id}: ${q.q}`);
      hit.setAttribute('aria-describedby', 'nodeTooltip');
      hit.addEventListener('pointerenter', () => highlight(leaf));
      hit.addEventListener('pointerleave', () => highlight(null));
      hit.addEventListener('focus', () => highlight(leaf));
      hit.addEventListener('blur', () => highlight(null));
      hit.addEventListener('click', () => { highlight(null); activate(leaf); });
      labelLayer.appendChild(hit);
      labels.push({ mesh: leaf, button: hit, isQuestion: true });
      return leaf;
    });
    addEdge(center, mesh, true);
    for (const leaf of leaves) addEdge(mesh, leaf);
    return { mesh, leaves };
  });
  for (let i = 0; i < branches.length; i++) addEdge(branches[i].mesh, branches[(i + 1) % branches.length].mesh);
  const stars = [];
  for (let i = 0; i < 95; i++) {
    const rand = n => (Math.sin(n * 91.713) * 43758.5453) % 1;
    stars.push(rand(i + 1) * 12, rand(i + 200) * 8, -Math.abs(rand(i + 400)) * 7 - 1);
  }
  const starGeometry = new BufferGeometry();
  starGeometry.setAttribute('position', new Float32BufferAttribute(stars, 3));
  world.add(new Points(starGeometry, new PointsMaterial({ color: '#7de8cd', size: .034, transparent: true, opacity: .55 })));
  host.dataset.nodeCount = String(nodes.length);
  host.querySelector('.graph-status').textContent = '7 topics · 21 questions · one connected practice';

  function layout() {
    center.position.set(0, 0, 0);
    branches.forEach(({ mesh, leaves }, i) => {
      mesh.position.fromArray((mobile ? narrowPositions : widePositions)[i]);
      leaves.forEach((leaf, j) => {
        const a = (j / leaves.length) * Math.PI * 2 + i * .73;
        const r = mobile ? .85 : 1.2 + (j % 2) * .3;
        leaf.position.copy(mesh.position).add(new Vector3(Math.cos(a) * r, Math.sin(a) * r * .8, Math.sin(a + i) * 1.7));
      });
    });
    for (const { a, b, line } of edges) line.geometry.setFromPoints([a.position, b.position]);
    for (const node of nodes) node.userData.restPosition = node.position.clone();
  }
  function draw(time = 0) {
    if (disposed) return;
    if (!time) time = performance.now();
    const delta = previousTime && time ? Math.min((time - previousTime) / 1000, .05) : 1 / 60;
    if (time) previousTime = time;
    const blend = motion.matches ? 1 : 1 - Math.exp(-delta * 9);
    const active = activeQuestion || branches.find(branch => branch.mesh.userData.id === selected)?.mesh || center;
    for (const node of nodes) {
      if (node.userData.restPosition) node.position.copy(node.userData.restPosition);
      const branchActive = node.userData.kind === 'topic' && node.userData.id === selected;
      const scale = node === activeQuestion ? 1.65 : branchActive ? 1.22 : 1;
      const pulse = node === active && !motion.matches ? 1 + Math.sin(time * .0024) * .045 : 1;
      node.scale.setScalar(node.userData.radius * scale * pulse * (node === hovered && node.userData.kind === 'question' ? 1.3 : 1));
      node.children[0].material.opacity = node === active && !motion.matches ? .37 + Math.sin(time * .0024) * .1 : .3;
    }
    if (!motion.matches) {
      active.position.y += Math.sin(time * .0018) * .065;
      active.position.z += Math.cos(time * .0015) * .04;
    }
    for (const { a, b, line } of edges) {
      const positions = line.geometry.attributes.position;
      positions.setXYZ(0, a.position.x, a.position.y, a.position.z);
      positions.setXYZ(1, b.position.x, b.position.y, b.position.z);
      positions.needsUpdate = true;
    }
    zoom += (targetZoom - zoom) * blend;
    focus.lerp(targetFocus, blend);
    world.rotation.y = yaw + (motion.matches || drag ? 0 : Math.sin(time * .00015) * .045);
    world.rotation.x = pitch;
    const distance = mobile ? Math.max(22.5, 12 / (2 * Math.tan(43 * Math.PI / 360) * camera.aspect)) : 18.5;
    camera.position.set(focus.x, focus.y, focus.z + distance / zoom);
    camera.lookAt(focus);
    camera.updateMatrixWorld();
    world.updateMatrixWorld(true);
    for (const { mesh, button, isCenter, isQuestion } of labels) {
      mesh.getWorldPosition(projected).project(camera);
      button.style.left = `${(projected.x * .5 + .5) * width}px`;
      button.style.top = `${(-projected.y * .5 + .5) * height + (isQuestion ? 0 : isCenter ? 37 : 27)}px`;
      button.style.visibility = projected.z > 1 || projected.z < -1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 ? 'hidden' : '';
      if (!isCenter && !isQuestion) button.setAttribute('aria-pressed', String(mesh.userData.topic === selected));
      button.classList.toggle('selected', !!selected && mesh.userData.topic === selected);
    }
    renderer.render(scene, camera);
    if (onFrame && activeQuestion) {
      activeQuestion.getWorldPosition(projected).project(camera);
      onFrame({ x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height, id: activeQuestion.userData.id });
    }
    if (hovered) positionTooltip(hovered);
    host.dataset.frames = String(++frame);
  }
  function animate(time) {
    raf = 0;
    if (!visible || document.hidden || disposed) return;
    draw(time);
    if (!motion.matches) raf = requestAnimationFrame(animate);
  }
  function schedule() { if (!raf && visible && !document.hidden && !disposed) raf = requestAnimationFrame(animate); }
  function resize() {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    mobile = width < 620;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    layout();
    if (activeQuestion) focusQuestion(activeQuestion.userData.id);
    draw(); schedule();
  }
  function selectTopic(id) {
    selected = id || '';
    activeQuestion = null;
    const branch = branches.find(item => item.mesh.userData.id === id);
    if (branch) {
      world.updateMatrixWorld(true);
      branch.mesh.getWorldPosition(targetFocus);
      targetZoom = 1.6;
      host.dataset.focus = id;
    }
    for (const node of nodes) {
      const active = node.userData.topic === selected;
      node.material.emissiveIntensity = active ? .55 : .17;
      node.scale.setScalar(node.userData.radius * (active && node.userData.kind === 'topic' ? 1.22 : 1));
    }
    draw();
  }
  function activate(node) {
    if (node.userData.kind === 'home') { focusHome(); onHome(); }
    else if (node.userData.kind === 'topic') { selectTopic(node.userData.id); onTopic(node.userData.id); }
    else { selectTopic(node.userData.topic); onQuestion(node.userData.id); }
  }
  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(pickables, false)[0]?.object || null;
  }
  function highlight(node) {
    if (!node && document.activeElement?.classList.contains('map-question-hit')) {
      node = nodes.find(item => item.userData.kind === 'question' && String(item.userData.id) === document.activeElement.dataset.question) || null;
    }
    if (hovered?.userData.kind === 'question') hovered.scale.setScalar(hovered.userData.radius);
    hovered = node;
    canvas.style.cursor = node ? 'pointer' : 'grab';
    tooltip.hidden = !node;
    if (node) {
      tooltip.textContent = node.userData.kind === 'question' ? `Q${node.userData.id} · ${node.userData.label}` : node.userData.kind === 'home' ? 'About Nicolas · click to meet me' : node.userData.label;
      if (node.userData.kind === 'question') node.scale.setScalar(node.userData.radius * 1.5);
      positionTooltip(node);
    }
    if (motion.matches) draw();
  }
  function positionTooltip(node) {
    node.getWorldPosition(projected);
    const distance = camera.position.distanceTo(projected);
    const gap = Math.max(22, node.scale.x * height / (2 * Math.tan(43 * Math.PI / 360) * distance) + 12);
    projected.project(camera);
    const x = (projected.x * .5 + .5) * width;
    const y = (-projected.y * .5 + .5) * height;
    const tipWidth = tooltip.offsetWidth, tipHeight = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(14, Math.min(width - tipWidth - 14, x - tipWidth / 2))}px`;
    tooltip.style.top = `${Math.max(95, y - tipHeight - gap < 95 ? y + gap : y - tipHeight - gap)}px`;
  }
  const down = e => { drag = { x: e.clientX, y: e.clientY, yaw, pitch, moved: false }; if (e.pointerType === 'mouse') canvas.setPointerCapture(e.pointerId); };
  const move = e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 7) drag.moved = true;
      if (drag.moved) { yaw = drag.yaw + dx * .004; pitch = Math.max(-.5, Math.min(.5, drag.pitch + dy * .003)); draw(); }
    } else highlight(pick(e));
  };
  const up = e => { const click = drag && !drag.moved; drag = null; if (click) { const node = pick(e); if (node) activate(node); } };
  const cancel = () => { drag = null; highlight(null); };
  const leave = e => { if (!drag && !e.relatedTarget?.closest?.('.map-question-hit,.map-label')) highlight(null); };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); visible = false; host.dataset.webgl = 'fallback'; host.querySelector('.graph-status').textContent = '3D paused. Topic buttons remain available below.'; });
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const intersection = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) { cancelAnimationFrame(raf); raf = 0; } else schedule();
  });
  intersection.observe(host);
  const visibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else schedule(); };
  document.addEventListener('visibilitychange', visibility);
  const motionChange = () => { cancelAnimationFrame(raf); raf = 0; schedule(); };
  motion.addEventListener('change', motionChange);
  function reset() {
    yaw = pitch = 0; targetZoom = 1; targetFocus.set(0, 0, 0);
    host.dataset.focus = 'overview'; selectTopic(''); draw(); schedule();
  }
  function focusHome() { targetFocus.set(0, 0, 0); targetZoom = 1.38; host.dataset.focus = 'home'; draw(); schedule(); }
  function focusQuestion(id) {
    const node = nodes.find(item => item.userData.kind === 'question' && item.userData.id === id);
    if (!node) return;
    activeQuestion = node;
    world.updateMatrixWorld(true); node.getWorldPosition(targetFocus);
    const readingArea = getReadingArea?.();
    if (readingArea && width >= 900) {
      const targetX = (readingArea.left + readingArea.right) / 2;
      targetFocus.x += (1 - 2 * targetX / width) * (18.5 / READING_ZOOM) * Math.tan(43 * Math.PI / 360) * camera.aspect;
    }
    node.material.emissiveIntensity = .8;
    node.scale.setScalar(node.userData.radius * 1.65);
    targetZoom = READING_ZOOM; host.dataset.focus = `q${id}`; draw(); schedule();
  }
  function questionSide(id) {
    const node = nodes.find(item => item.userData.kind === 'question' && item.userData.id === id);
    if (!node) return 'left';
    world.updateMatrixWorld(true); camera.updateMatrixWorld();
    node.getWorldPosition(projected).project(camera);
    return projected.x < 0 ? 'left' : 'right';
  }
  function zoomBy(delta) { targetZoom = Math.min(3.2, Math.max(.65, targetZoom + delta)); host.dataset.zoom = targetZoom.toFixed(2); draw(); schedule(); }
  function dispose() {
    disposed = true; cancelAnimationFrame(raf);
    observer.disconnect(); intersection.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    motion.removeEventListener('change', motionChange);
    const geometries = new Set(), materials = new Set();
    scene.traverse(object => { if (object.geometry) geometries.add(object.geometry); if (object.material) materials.add(object.material); });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    glowTexture.dispose(); renderer.dispose(); labelLayer.replaceChildren();
    canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel);
    canvas.removeEventListener('pointerleave', leave);
  }
  resize();
  function reframe() { if (activeQuestion) focusQuestion(activeQuestion.userData.id); else draw(); }
  return { selectTopic, questionSide, focusQuestion, focusHome, reframe, reset, zoom: zoomBy, dispose };
}
