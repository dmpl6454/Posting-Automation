// @ts-nocheck -- verbatim-ported WebGL/three.js scene (untyped window.THREE + numeric hot-loops); see LandingHome.tsx.
/* eslint-disable @typescript-eslint/no-explicit-any */
// Ported verbatim (to a module) from the Claude Design "PostAutomation Home.dc.html"
// three.js scene: wavy ocean + glowing wireframe grid, rising/crest sparkles,
// floating monolith cube with glyph faces, mountains, air embers, UnrealBloom.
// Requires window.THREE + the postprocessing examples to be loaded first.
// Returns controls the React host drives (mouse parallax + cursor-proximity cube heat).

export interface PASceneControls {
  destroy: () => void;
  setMouse: (x: number, y: number) => void;
  setCubeHeat: (h: number) => void;
}

export function initPAScene(accentColor = "#2f6bff"): PASceneControls | null {
  const THREE = (window as any).THREE;
  const canvas = document.getElementById("pa-canvas") as HTMLCanvasElement | null;
  if (!THREE || !THREE.EffectComposer || !THREE.UnrealBloomPass || !THREE.RenderPass || !canvas) {
    return null;
  }

  let mx = 0;
  let my = 0;
  let cubeHeat = 0;
  let cubeHeatSm = 0;
  let raf = 0;

  // ---- texture / sprite helpers ----
  function gradTexture() {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 512;
    const g = c.getContext("2d")!;
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, "#071026");
    grd.addColorStop(0.45, "#050b1c");
    grd.addColorStop(0.7, "#040813");
    grd.addColorStop(1, "#02030a");
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 512);
    return new THREE.CanvasTexture(c);
  }

  function radialSprite(r: number, gg: number, b: number, a0: number) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, `rgba(${r},${gg},${b},${a0})`);
    grd.addColorStop(0.4, `rgba(${r},${gg},${b},${a0 * 0.4})`);
    grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    return new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
  }

  function dotSprite() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.3, "rgba(200,225,255,0.7)");
    grd.addColorStop(1, "rgba(200,225,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  function glyphTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d")!;
    g.translate(128, 128);
    g.rotate(-0.12);
    g.fillStyle = "#eaf2ff";
    g.beginPath();
    g.moveTo(-82, 22);
    g.lineTo(88, -66);
    g.lineTo(20, 96);
    g.lineTo(-10, 34);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(8,16,42,0.55)";
    g.beginPath();
    g.moveTo(-10, 34);
    g.lineTo(88, -66);
    g.lineTo(32, 18);
    g.closePath();
    g.fill();
    return new THREE.CanvasTexture(c);
  }

  function makeMountain(scene: any, mxx: number, faceAngle: number, dot: any) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(8, 8.5, 5, 1),
      new THREE.MeshBasicMaterial({ color: 0x0a1a3e })
    );
    cone.position.set(mxx, 2.0, -5);
    cone.rotation.y = faceAngle;
    scene.add(cone);
    const N = 150;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.pow(Math.random(), 1.6);
      const radius = 8 * (1 - u) + 0.2;
      const theta = faceAngle + (Math.random() * 1.3 - 0.65);
      pos[i * 3] = mxx + Math.cos(theta) * radius;
      pos[i * 3 + 1] = 2.0 - 4.25 + u * 8.5;
      pos[i * 3 + 2] = -5 + Math.sin(theta) * radius;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x5b9cff,
      size: 0.16,
      map: dot,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 1.0,
      sizeAttenuation: true,
    });
    scene.add(new THREE.Points(geo, mat));
  }

  // ---- scene setup ----
  let W = canvas.clientWidth || window.innerWidth;
  let H = canvas.clientHeight || window.innerHeight;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);

  const scene = new THREE.Scene();
  scene.background = gradTexture();
  scene.fog = new THREE.FogExp2(0x03050d, 0.042);

  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 200);
  camera.position.set(0, 1.3, 17);

  const accent = new THREE.Color(accentColor);
  const ar = Math.round(accent.r * 255);
  const ag = Math.round(accent.g * 255);
  const ab = Math.round(accent.b * 255);
  const dot = dotSprite();

  // wavy ocean surface
  const waterGeo = new THREE.PlaneGeometry(180, 180, 130, 130);
  const water = new THREE.Mesh(waterGeo, new THREE.MeshBasicMaterial({ color: 0x0c2a5e }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -2.2;
  scene.add(water);
  const wpos = waterGeo.attributes.position;
  const wbase = Float32Array.from(wpos.array);

  // glowing wireframe grid
  const wireGeo = new THREE.PlaneGeometry(180, 180, 64, 64);
  const wireMesh = new THREE.Mesh(
    wireGeo,
    new THREE.MeshBasicMaterial({
      color: 0x57a0ff,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  wireMesh.rotation.x = -Math.PI / 2;
  wireMesh.position.y = -2.14;
  scene.add(wireMesh);
  const wirePos = wireGeo.attributes.position;
  const wireBase = Float32Array.from(wirePos.array);

  const waveAt = (x: number, z: number, t: number) =>
    Math.sin(x * 0.16 + t * 0.9) * 0.6 +
    Math.sin(z * 0.21 + t * 1.05) * 0.5 +
    Math.sin((x + z) * 0.12 + t * 0.7) * 0.32 +
    Math.sin(x * 0.05 - t * 0.5) * 0.22;

  // reflection glow under cube
  const refl = radialSprite(ar, ag, ab, 0.55);
  refl.scale.set(5, 7, 1);
  refl.position.set(0, -1.0, -0.5);
  scene.add(refl);

  // rising sparkles
  const SN = 1100;
  const spos = new Float32Array(SN * 3);
  const sbase = new Float32Array(SN * 3);
  const svel = new Float32Array(SN);
  const slife = new Float32Array(SN);
  const smax = new Float32Array(SN);
  for (let i = 0; i < SN; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.pow(Math.random(), 0.55) * 44;
    const bx = Math.cos(a) * rr;
    const bz = Math.sin(a) * rr * 0.7 - 2;
    sbase[i * 3] = bx;
    sbase[i * 3 + 1] = -2.2;
    sbase[i * 3 + 2] = bz;
    spos[i * 3] = bx;
    spos[i * 3 + 1] = -2.2 + Math.random() * 4;
    spos[i * 3 + 2] = bz;
    svel[i] = 0.006 + Math.random() * 0.02;
    slife[i] = Math.random();
    smax[i] = 0.6 + Math.random() * 1.4;
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute("position", new THREE.BufferAttribute(spos, 3));
  const specks = new THREE.Points(
    sGeo,
    new THREE.PointsMaterial({
      color: 0xaad4ff,
      size: 0.16,
      map: dot,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.95,
      sizeAttenuation: true,
    })
  );
  scene.add(specks);

  // crest sparkles
  const CN = 420;
  const cpos = new Float32Array(CN * 3);
  const cbase = new Float32Array(CN * 3);
  for (let i = 0; i < CN; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = 2 + Math.pow(Math.random(), 0.6) * 38;
    cbase[i * 3] = Math.cos(a) * rr;
    cbase[i * 3 + 1] = 0;
    cbase[i * 3 + 2] = Math.sin(a) * rr * 0.7 - 2;
  }
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute("position", new THREE.BufferAttribute(cpos, 3));
  const crests = new THREE.Points(
    cGeo,
    new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.085,
      map: dot,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.8,
      sizeAttenuation: true,
    })
  );
  scene.add(crests);

  // monolith cube
  const cubeGroup = new THREE.Group();
  const s = 3.3;
  cubeGroup.add(
    new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.26 }))
  );
  cubeGroup.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(s * 0.66, s * 0.66, s * 0.66),
      new THREE.MeshBasicMaterial({ color: 0x2a5fe0, transparent: true, opacity: 0.5 })
    )
  );
  cubeGroup.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s)),
      new THREE.LineBasicMaterial({ color: 0xa8caff })
    )
  );
  const glyphTex = glyphTexture();
  [1, -1].forEach((d) => {
    const gl = new THREE.Mesh(
      new THREE.PlaneGeometry(s * 0.8, s * 0.8),
      new THREE.MeshBasicMaterial({ map: glyphTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    gl.position.z = (s / 2 + 0.02) * d;
    if (d < 0) gl.rotation.y = Math.PI;
    cubeGroup.add(gl);
  });
  cubeGroup.position.y = 0.35;
  scene.add(cubeGroup);
  const cubeMats = {
    shell: cubeGroup.children[0].material,
    inner: cubeGroup.children[1].material,
    edge: cubeGroup.children[2].material,
    refl: refl.material,
  };
  const cubeBase = {
    shell: cubeGroup.children[0].material.color.clone(),
    inner: cubeGroup.children[1].material.color.clone(),
    edge: cubeGroup.children[2].material.color.clone(),
  };
  const cubeHot = {
    shell: new THREE.Color("#b06bff"),
    inner: new THREE.Color("#8a3df0"),
    edge: new THREE.Color("#f0dcff"),
  };

  // mountains
  makeMountain(scene, -11.5, 0, dot);
  makeMountain(scene, 11.5, Math.PI, dot);

  // air embers
  const EN = 220;
  const epos = new Float32Array(EN * 3);
  const evel = new Float32Array(EN);
  for (let i = 0; i < EN; i++) {
    epos[i * 3] = (Math.random() - 0.5) * 46;
    epos[i * 3 + 1] = Math.random() * 16 - 2.2;
    epos[i * 3 + 2] = (Math.random() - 0.5) * 24 - 3;
    evel[i] = 0.004 + Math.random() * 0.012;
  }
  const eGeo = new THREE.BufferGeometry();
  eGeo.setAttribute("position", new THREE.BufferAttribute(epos, 3));
  const embers = new THREE.Points(
    eGeo,
    new THREE.PointsMaterial({
      color: 0x9fc6ff,
      size: 0.08,
      map: dot,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.6,
      sizeAttenuation: true,
    })
  );
  scene.add(embers);

  // bloom
  const composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(W, H), 0.9, 0.62, 0.12);
  composer.addPass(bloom);

  const onResize = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    W = w;
    H = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    if (w > 820) camera.setViewOffset(Math.round(w * 1.35), h, 0, 0, w, h);
    else camera.clearViewOffset();
  };
  window.addEventListener("resize", onResize);
  onResize();

  const warr = wpos.array as Float32Array;
  const earr = eGeo.attributes.position.array as Float32Array;
  const clock = new THREE.Clock();

  const loop = () => {
    const t = clock.getElapsedTime();
    for (let i = 0; i < warr.length; i += 3) {
      warr[i + 2] = wbase[i + 2] + waveAt(wbase[i], wbase[i + 1], t);
    }
    wpos.needsUpdate = true;
    const wp = wirePos.array as Float32Array;
    for (let i = 0; i < wp.length; i += 3) {
      wp[i + 2] = wireBase[i + 2] + waveAt(wireBase[i], wireBase[i + 1], t);
    }
    wirePos.needsUpdate = true;
    for (let i = 0; i < SN; i++) {
      slife[i] += svel[i];
      if (slife[i] > smax[i]) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.pow(Math.random(), 0.55) * 44;
        sbase[i * 3] = Math.cos(a) * rr;
        sbase[i * 3 + 2] = Math.sin(a) * rr * 0.7 - 2;
        slife[i] = 0;
        smax[i] = 0.6 + Math.random() * 1.4;
        svel[i] = 0.006 + Math.random() * 0.02;
      }
      const prog = slife[i] / smax[i];
      spos[i * 3] = sbase[i * 3];
      spos[i * 3 + 1] = -2.2 + prog * 4.2;
      spos[i * 3 + 2] = sbase[i * 3 + 2];
    }
    sGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < CN; i++) {
      const x = cbase[i * 3];
      const z = cbase[i * 3 + 2];
      cpos[i * 3] = x;
      cpos[i * 3 + 1] = -2.2 + waveAt(x, z + t * 0.5, t) + 0.1;
      cpos[i * 3 + 2] = z;
    }
    cGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < EN; i++) {
      earr[i * 3 + 1] += evel[i];
      if (earr[i * 3 + 1] > 13) earr[i * 3 + 1] = -2.2;
    }
    eGeo.attributes.position.needsUpdate = true;

    cubeHeatSm = cubeHeatSm + (cubeHeat - cubeHeatSm) * 0.08;
    const heat = cubeHeatSm;
    cubeMats.shell.color.copy(cubeBase.shell).lerp(cubeHot.shell, heat);
    cubeMats.inner.color.copy(cubeBase.inner).lerp(cubeHot.inner, heat);
    cubeMats.edge.color.copy(cubeBase.edge).lerp(cubeHot.edge, heat);
    cubeMats.shell.opacity = 0.26 + heat * 0.22;
    cubeMats.inner.opacity = 0.5 + heat * 0.3;
    if (cubeMats.refl) cubeMats.refl.opacity = 1 + heat * 0.5;

    cubeGroup.position.y = 0.35 + Math.sin(t * 0.6) * 0.2;
    cubeGroup.rotation.y += 0.0024;
    cubeGroup.rotation.x = Math.sin(t * 0.3) * 0.05;
    camera.position.x += (mx * 0.8 - camera.position.x) * 0.035;
    camera.position.y += (1.3 - my * 0.5 - camera.position.y) * 0.035;
    camera.lookAt(0, 0.4, 0);
    composer.render();
    raf = requestAnimationFrame(loop);
  };
  loop();

  return {
    setMouse: (x: number, y: number) => {
      mx = x;
      my = y;
    },
    setCubeHeat: (h: number) => {
      cubeHeat = h;
    },
    destroy: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      try {
        renderer.dispose();
      } catch {
        /* noop */
      }
    },
  };
}
