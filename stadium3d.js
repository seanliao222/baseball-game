/* stadium3d.js — procedural Three.js broadcast-style stadium for the baseball game.
 *
 * Renders a lit night-game ballpark with articulated players, a TV-style camera rig
 * and real ball flight. Everything is generated in code (no external assets).
 *
 * The 2D game logic still works in an 800x600 "game px" space. The batter camera is
 * built so the 3D plate plane lines up with the 2D strike-zone overlay: pxToPlane()
 * maps a game-px point to a world point on the plate plane, which is how pitched
 * balls land exactly where the 2D aiming UI says they will.
 *
 * Exposes global `Stadium3D`. If THREE is missing, `Stadium3D.ok` stays false and the
 * game falls back to its legacy 2D renderer.
 */
const Stadium3D = (function () {
    'use strict';
    const api = { ok: false, visible: false };
    if (typeof THREE === 'undefined') return api;

    // ───────────────────────── constants ─────────────────────────
    const GW = 800, GH = 600;      // logical game size (matches W/H in index.html)
    const SZX = 400, SZY = 400;    // strike-zone centre in game px
    const K = 180;                 // game px per metre on the plate plane
    const ZONE_Y = 0.80;           // zone centre height (m)
    const MOUND_Z = -18.44;
    const BASE = 19.4;             // 1B/3B offset along each axis (27.43 m / sqrt 2)
    const HIP_Y = 0.995;
    const BASES = [[0, 0], [BASE, -BASE], [0, -2 * BASE], [-BASE, -BASE]]; // home,1B,2B,3B (x,z)

    const rnd = (a, b) => Math.random() * (b - a) + a;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const ease = t => t * t * (3 - 2 * t);
    const easeOut = t => 1 - (1 - t) * (1 - t);
    const damp = (cur, tgt, k, dt) => lerp(cur, tgt, 1 - Math.exp(-k * dt));
    function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (s.charCodeAt(i) + ((h << 5) - h)) | 0; return Math.abs(h); }
    function seeded(seed) { let s = seed | 0; return () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) % 100000) / 100000; }; }
    function lum(hex) { const c = new THREE.Color(hex); return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }

    // wall radius from home plate at angle th (rad, 0 = dead centre)
    const wallR = th => { const a = Math.abs(th); return a >= Math.PI / 4 ? 100 : 100 + 22 * Math.cos(2 * th); };
    // outer-bowl radius (stands curve in beyond the foul poles)
    const bowlR = th => { const a = Math.abs(th), w = wallR(th); return a <= Math.PI / 4 ? w : lerp(100, 58, clamp((a - Math.PI / 4) / (Math.PI * 0.36), 0, 1)); };

    // ───────────────────────── renderer / scene ─────────────────────────
    let renderer, scene, camera, zoneCam, canvas3d, maxAniso = 4;
    let cw = 800, ch = 600;                       // canvas px (CSS px; DPR handled by setPixelRatio)
    let rect = { x: 0, y: 0, w: 800, h: 600 };    // game rect inside the canvas

    const sun = new THREE.DirectionalLight(0xfff2dc, 1.15);
    let scoreboardCtx = null, scoreboardTex = null, scoreboardKey = '';
    let flashPts = null;
    const flags = [];
    function waveFlags(t) {
        flags.forEach((f, i) => {
            const pos = f.geometry.attributes.position, base = f.userData.base;
            for (let k = 0; k < pos.count; k++) { const x = base[k * 3]; pos.array[k * 3 + 2] = Math.sin(x * 0.9 - t * 3 + i) * 0.45 * (x / 11); pos.array[k * 3 + 1] = base[k * 3 + 1] + Math.sin(x * 0.6 - t * 2.4 + i) * 0.12 * (x / 11); }
            pos.needsUpdate = true;
        });
    }

    function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function texOf(c, o = {}) {
        const t = new THREE.CanvasTexture(c);
        if (o.wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(o.rx || 1, o.ry || 1); }
        t.anisotropy = maxAniso;
        return t;
    }
    const std = (color, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85, metalness: 0 }, o));

    // ───────────────────────── field textures ─────────────────────────
    function buildFieldTexture() {
        const S = 2048, X0 = -130, Z0 = -200, SPAN = 260, m = S / SPAN;
        const c = canvasOf(S, S), g = c.getContext('2d');
        const X = x => (x - X0) * m, Z = z => (z - Z0) * m;
        const R = seeded(11);
        g.fillStyle = '#26702f'; g.fillRect(0, 0, S, S);

        const stripes = () => {
            for (let i = 0, z = Z0; z < 60; z += 5.2, i++) {
                g.fillStyle = i % 2 ? '#256c2d' : '#2d7c37';
                g.fillRect(0, Z(z), S, 5.2 * m + 1);
            }
        };
        const grain = (n, cols, sz) => {
            for (let i = 0; i < n; i++) {
                g.fillStyle = cols[(R() * cols.length) | 0];
                g.fillRect(R() * S, R() * S, sz, sz);
            }
        };
        stripes();
        grain(90000, ['rgba(20,70,25,0.16)', 'rgba(120,190,100,0.10)', 'rgba(10,40,15,0.12)'], 2);

        // warning track along the wall
        g.save();
        g.lineWidth = 5.2 * m; g.strokeStyle = '#8b6a45'; g.lineCap = 'butt';
        g.beginPath();
        for (let i = 0, N = 160; i <= N; i++) {
            const th = lerp(-Math.PI * 0.5, Math.PI * 0.5, i / N), r = (th > -Math.PI / 4 - 1e-6 && th < Math.PI / 4 + 1e-6 ? wallR(th) : 100) - 2.6;
            const x = r * Math.sin(th), z = -r * Math.cos(th);
            i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z));
        }
        g.stroke(); g.restore();

        // infield skin
        const skin = g.createRadialGradient(X(0), Z(MOUND_Z), 3 * m, X(0), Z(MOUND_Z), 29 * m);
        skin.addColorStop(0, '#a47248'); skin.addColorStop(1, '#996a42');
        g.fillStyle = skin; g.beginPath(); g.arc(X(0), Z(MOUND_Z), 28.6 * m, 0, Math.PI * 2); g.fill();

        // infield grass (diamond, scaled in around its centre)
        const cz = -BASE, sc = 0.82;
        const gp = [[0, 0], [BASE, -BASE], [0, -2 * BASE], [-BASE, -BASE]].map(([x, z]) => [x * sc, cz + (z - cz) * sc]);
        g.save();
        g.beginPath(); gp.forEach(([x, z], i) => i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))); g.closePath(); g.clip();
        stripes();
        grain(30000, ['rgba(20,70,25,0.16)', 'rgba(120,190,100,0.10)'], 2);
        g.restore();
        // mound + base cut-outs
        g.fillStyle = '#a77649';
        g.beginPath(); g.arc(X(0), Z(MOUND_Z), 3.1 * m, 0, Math.PI * 2); g.fill();
        BASES.slice(1).forEach(([x, z]) => { g.beginPath(); g.arc(X(x), Z(z), 2.5 * m, 0, Math.PI * 2); g.fill(); });
        g.beginPath(); g.arc(X(0), Z(0), 4.4 * m, 0, Math.PI * 2); g.fill();

        // dirt grain (clipped to the skin circle)
        g.save(); g.beginPath(); g.arc(X(0), Z(MOUND_Z), 28.6 * m, 0, Math.PI * 2); g.clip();
        for (let i = 0; i < 60000; i++) {
            g.fillStyle = R() < 0.5 ? 'rgba(90,55,25,0.14)' : 'rgba(225,185,130,0.12)';
            g.fillRect(R() * S, R() * S, 2, 2);
        }
        g.restore();
        // raked arcs near the grass line
        g.strokeStyle = 'rgba(70,40,15,0.10)'; g.lineWidth = 1.2;
        for (let k = 0; k < 14; k++) { g.beginPath(); g.arc(X(0), Z(MOUND_Z), (26 - k * 0.6) * m, Math.PI * 0.05, Math.PI * 0.95, true); g.stroke(); }
        return c;
    }

    function buildPlateDirtTexture() {
        const S = 1536, c = canvasOf(S, S), g = c.getContext('2d'), R = seeded(5), m = S / 14;
        const X = x => (x + 7) * m, Z = z => (z + 7) * m;
        g.fillStyle = '#a2704a'; g.fillRect(0, 0, S, S);
        for (let i = 0; i < 150000; i++) {
            g.fillStyle = R() < 0.5 ? 'rgba(90,55,25,0.18)' : 'rgba(230,190,135,0.16)';
            g.fillRect(R() * S, R() * S, 2.5, 2.5);
        }
        // trampled batter's boxes + catcher's area
        g.fillStyle = 'rgba(80,48,22,0.28)';
        [[-1, 0], [1, 0]].forEach(([s]) => { g.beginPath(); g.ellipse(X(s * 0.95), Z(0), 0.7 * m, 0.95 * m, 0, 0, Math.PI * 2); g.fill(); });
        g.fillStyle = 'rgba(80,48,22,0.22)'; g.beginPath(); g.ellipse(X(0), Z(1.0), 1.1 * m, 0.7 * m, 0, 0, Math.PI * 2); g.fill();
        // cleat marks
        g.fillStyle = 'rgba(60,35,15,0.35)';
        for (let i = 0; i < 160; i++) { const a = R() * Math.PI * 2, r = R() * 2.6; g.fillRect(X(Math.cos(a) * r * 1.1), Z(Math.sin(a) * r * 0.9), 3, 6); }
        // soft edge so it melts into the big field texture
        g.globalCompositeOperation = 'destination-in';
        const fade = g.createRadialGradient(S / 2, S / 2, S * 0.28, S / 2, S / 2, S * 0.5);
        fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = fade; g.fillRect(0, 0, S, S);
        return c;
    }

    function buildWallTexture() {
        const c = canvasOf(1024, 128), g = c.getContext('2d');
        g.fillStyle = '#0f3a24'; g.fillRect(0, 0, 1024, 128);
        const brands = ['SLUGGER', 'FASTBALL', 'HOME RUN', 'PLAY BALL', 'CLASSIC', 'ACE', 'GRAND SLAM', 'LEAGUE'];
        const cols = [['#c8102e', '#fff'], ['#0b3d91', '#fff'], ['#f2c500', '#111'], ['#ffffff', '#0b3d91'], ['#111', '#f2c500'], ['#00843d', '#fff']];
        for (let i = 0; i < 8; i++) {
            const [bg, fg] = cols[i % cols.length];
            g.fillStyle = bg; g.fillRect(i * 128 + 4, 30, 120, 74);
            g.fillStyle = fg; g.font = 'bold 20px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(brands[i], i * 128 + 64, 67);
        }
        g.fillStyle = '#f5d000'; g.fillRect(0, 0, 1024, 16);      // top-of-wall line
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 108, 1024, 20);
        return c;
    }

    function buildCrowdTexture(seed, tint) {
        const W_ = 512, H_ = 256, c = canvasOf(W_, H_), g = c.getContext('2d'), R = seeded(seed);
        g.fillStyle = '#12141c'; g.fillRect(0, 0, W_, H_);
        const shirts = tint.concat(['#d8d8d8', '#1a1a22', '#2a4a8a', '#a82a2a', '#e9e2cf', '#35507a', '#7a2a2a']);
        const skins = ['#f1c9a3', '#d8a37a', '#b87a52', '#8a5a3a', '#e8b890'];
        for (let row = 0, y = 4; y < H_ - 6; row++, y += 11) {
            g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, y + 9, W_, 1);
            for (let x = (row % 2) * 4; x < W_; x += 8.5) {
                if (R() < 0.12) continue; // empty seat
                g.fillStyle = shirts[(R() * shirts.length) | 0]; g.fillRect(x, y + 3, 7, 7);
                g.fillStyle = skins[(R() * skins.length) | 0]; g.beginPath(); g.arc(x + 3.5, y + 2, 2.6, 0, Math.PI * 2); g.fill();
            }
        }
        return c;
    }

    function buildSkyTexture() {
        const c = canvasOf(1024, 512), g = c.getContext('2d'), R = seeded(21);
        const gr = g.createLinearGradient(0, 0, 0, 512);
        gr.addColorStop(0, '#2f78d2'); gr.addColorStop(0.45, '#5a9fe6'); gr.addColorStop(0.8, '#a6d0f3'); gr.addColorStop(1, '#d9ecfa');
        g.fillStyle = gr; g.fillRect(0, 0, 1024, 512);
        for (let i = 0; i < 26; i++) {           // soft cumulus puffs
            const cx = R() * 1024, cy = 90 + R() * 300, n = 6 + (R() * 8 | 0);
            for (let k = 0; k < n; k++) {
                const x = cx + (R() - 0.5) * 150, y = cy + (R() - 0.5) * 26, r = 26 + R() * 44;
                const rg = g.createRadialGradient(x, y, 0, x, y, r);
                rg.addColorStop(0, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
                g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
            }
        }
        return c;
    }

    function glowTexture() {
        const c = canvasOf(128, 128), g = c.getContext('2d');
        const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,244,210,0.55)'); gr.addColorStop(1, 'rgba(255,240,200,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
        return new THREE.CanvasTexture(c);
    }

    // ───────────────────────── stadium build ─────────────────────────
    function stripMesh(rows, uvScaleU, uvScaleV, material) {
        // rows: array of [vertexA(x,y,z), vertexB(x,y,z)] pairs along an arc
        const pos = [], uv = [], idx = [];
        let u = 0;
        rows.forEach((r, i) => {
            if (i) { const p = rows[i - 1]; u += Math.hypot(r[0][0] - p[0][0], r[0][2] - p[0][2]); }
            pos.push(...r[0], ...r[1]);
            const vlen = Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1], r[1][2] - r[0][2]);
            uv.push(u * uvScaleU, 0, u * uvScaleU, vlen * uvScaleV);
            if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        g.setIndex(idx); g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, material);
        mesh.receiveShadow = false;
        return mesh;
    }

    function buildStadium() {
        scene.background = texOf(buildSkyTexture());
        scene.fog = new THREE.FogExp2(0xb9d6ee, 0.0017);

        scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x6f7f4c, 0.5));
        sun.position.set(-38, 72, 40);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        const sc = sun.shadow.camera; sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 10; sc.far = 140;
        sun.shadow.bias = -0.0006;
        sun.target.position.set(0, 0, -16);
        scene.add(sun, sun.target);

        // ground
        const fieldTex = texOf(buildFieldTexture());
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.MeshStandardMaterial({ map: fieldTex, roughness: 1 }));
        ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, -70); ground.receiveShadow = true;
        scene.add(ground);

        const plate = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ map: texOf(buildPlateDirtTexture()), transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        plate.rotation.x = -Math.PI / 2; plate.position.set(0, 0.004, 0); plate.receiveShadow = true;
        scene.add(plate);

        // chalk
        const chalk = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.9, emissive: 0x555550, emissiveIntensity: 0.6 });
        const line = (w, l, x, z, ry) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, l), chalk); m.position.set(x, 0.012, z); m.rotation.y = ry || 0; m.receiveShadow = true; scene.add(m); return m; };
        const FL = 112;
        line(0.12, FL, FL / 2 * Math.SQRT1_2, -FL / 2 * Math.SQRT1_2, Math.PI / 4);
        line(0.12, FL, -FL / 2 * Math.SQRT1_2, -FL / 2 * Math.SQRT1_2, -Math.PI / 4);
        [-1, 1].forEach(s => {                         // batter's boxes
            const x0 = s * 0.366, x1 = s * (0.366 + 1.22);
            line(0.06, 1.83, x0, 0, 0); line(0.06, 1.83, x1, 0, 0);
            line(1.22, 0.06, (x0 + x1) / 2, -0.915, 0); line(1.22, 0.06, (x0 + x1) / 2, 0.915, 0);
        });

        // home plate
        const sh = new THREE.Shape(); sh.moveTo(-0.216, 0.216); sh.lineTo(0.216, 0.216); sh.lineTo(0.216, 0); sh.lineTo(0, -0.216); sh.lineTo(-0.216, 0);
        const pg = new THREE.ShapeGeometry(sh); pg.rotateX(-Math.PI / 2);
        const hp = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x666666, emissiveIntensity: 0.6 }));
        hp.position.y = 0.02; hp.receiveShadow = true; scene.add(hp);

        // bases
        BASES.slice(1).forEach(([x, z]) => {
            const b = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.1, 0.38), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x555555, emissiveIntensity: 0.5 }));
            b.position.set(x * 0.97, 0.05, z * 0.97 + (z === -BASE ? 0 : 0)); b.rotation.y = Math.PI / 4; b.castShadow = true; b.receiveShadow = true; scene.add(b);
        });

        // mound + rubber
        const mound = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 4.2, 0.26, 40), new THREE.MeshStandardMaterial({ color: 0xa6764a, roughness: 1 }));
        mound.position.set(0, 0.13, MOUND_Z); mound.receiveShadow = true; mound.castShadow = false; scene.add(mound);
        const rubber = new THREE.Mesh(new THREE.BoxGeometry(0.61, 0.04, 0.15), chalk);
        rubber.position.set(0, 0.28, MOUND_Z); scene.add(rubber);

        // outfield wall
        const wallTex = texOf(buildWallTexture(), { wrap: true });
        const wallRows = [], N = 220;
        for (let i = 0; i <= N; i++) {
            const th = lerp(-Math.PI * 0.62, Math.PI * 0.62, i / N), r = bowlR(th);
            const x = r * Math.sin(th), z = -r * Math.cos(th);
            wallRows.push([[x, 0, z], [x, 3.0, z]]);
        }
        const wall = stripMesh(wallRows, 1 / 64, 1 / 3.0, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7, side: THREE.DoubleSide, emissive: 0x112211, emissiveIntensity: 0.15 }));
        scene.add(wall);

        // batter's eye (dark green panel behind CF)
        const eye = new THREE.Mesh(new THREE.PlaneGeometry(34, 8), new THREE.MeshStandardMaterial({ color: 0x0b2316, roughness: 1 }));
        eye.position.set(0, 7, -wallR(0) - 1.0); scene.add(eye);

        // foul poles
        [-1, 1].forEach(s => {
            const th = s * Math.PI / 4, r = 100;
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 22, 8), new THREE.MeshStandardMaterial({ color: 0xffd800, emissive: 0x806c00, emissiveIntensity: 0.7 }));
            pole.position.set(r * Math.sin(th), 11, -r * Math.cos(th)); scene.add(pole);
        });

        // stands: lower deck, concourse wall, upper deck, roof lip
        const crowdA = texOf(buildCrowdTexture(3, ['#c8102e', '#e0e0e0']), { wrap: true });
        const crowdB = texOf(buildCrowdTexture(9, ['#0b3d91', '#d8d8d8']), { wrap: true });
        const mkCrowdMat = t => new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, color: 0xe4e8f2 });
        const arc = (fnIn, yIn, fnOut, yOut, th0, th1, mat, su, sv) => {
            const rows = [], n = 200;
            for (let i = 0; i <= n; i++) {
                const th = lerp(th0, th1, i / n), s = Math.sin(th), c = -Math.cos(th);
                const ri = fnIn(th), ro = fnOut(th);
                rows.push([[ri * s, yIn, ri * c], [ro * s, yOut, ro * c]]);
            }
            const m = stripMesh(rows, su, sv, mat); scene.add(m); return m;
        };
        const T0 = -Math.PI * 0.62, T1 = Math.PI * 0.62;
        arc(th => bowlR(th) + 3, 3.2, th => bowlR(th) + 26, 10.5, T0, T1, mkCrowdMat(crowdA), 1 / 40, 1 / 20);
        arc(th => bowlR(th) + 26, 10.5, th => bowlR(th) + 29, 10.5, T0, T1, new THREE.MeshBasicMaterial({ color: 0x8a93a6, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 29, 10.5, th => bowlR(th) + 31, 15, T0, T1, new THREE.MeshBasicMaterial({ color: 0x9aa3b6, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 31, 15, th => bowlR(th) + 58, 28, T0, T1, mkCrowdMat(crowdB), 1 / 40, 1 / 26);
        arc(th => bowlR(th) + 58, 28, th => bowlR(th) + 58, 32, T0, T1, new THREE.MeshBasicMaterial({ color: 0x6c7488, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 58, 32, th => bowlR(th) + 24, 32, T0, T1, new THREE.MeshBasicMaterial({ color: 0x5a6174, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 3, 3.2, th => bowlR(th) + 3, 0, T0, T1, new THREE.MeshBasicMaterial({ color: 0x7b869c, side: THREE.DoubleSide }), 1, 1);

        // scoreboard
        const sb = canvasOf(1024, 400); scoreboardCtx = sb.getContext('2d'); scoreboardTex = texOf(sb);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(36, 14), new THREE.MeshBasicMaterial({ map: scoreboardTex }));
        board.position.set(0, 14, -bowlR(0) - 14); scene.add(board);
        drawScoreboard(null);

        // light towers
        const glow = glowTexture();
        const panelC = canvasOf(128, 96), pg2 = panelC.getContext('2d');
        pg2.fillStyle = '#222'; pg2.fillRect(0, 0, 128, 96);
        for (let y = 6; y < 96; y += 14) for (let x = 6; x < 128; x += 14) { pg2.fillStyle = '#fffbe8'; pg2.beginPath(); pg2.arc(x + 4, y + 4, 5, 0, Math.PI * 2); pg2.fill(); }
        const panelTex = new THREE.CanvasTexture(panelC);
        [[-70, -70], [70, -70], [-118, -10], [118, -10], [-40, -148], [40, -148]].forEach(([x, z]) => {
            const gr = new THREE.Group();
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, 62, 8), new THREE.MeshBasicMaterial({ color: 0x181c26 }));
            pole.position.y = 31; gr.add(pole);
            const panel = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), new THREE.MeshBasicMaterial({ map: panelTex, side: THREE.DoubleSide }));
            panel.position.y = 66; panel.lookAt(0, 66, 0); gr.add(panel);
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.8 }));
            sp.scale.set(46, 46, 1); sp.position.y = 66;   // (glow only matters for night games)
            gr.position.set(x, 0, z); scene.add(gr);
            panel.rotation.set(0, Math.atan2(-x, -z) + Math.PI, 0);
        });

        // flags along the top of the upper deck
        const fc = canvasOf(256, 140), fg0 = fc.getContext('2d');
        for (let i = 0; i < 13; i++) { fg0.fillStyle = i % 2 ? '#ffffff' : '#c8202f'; fg0.fillRect(0, i * 140 / 13, 256, 140 / 13 + 1); }
        fg0.fillStyle = '#2a3f8f'; fg0.fillRect(0, 0, 110, 76);
        fg0.fillStyle = '#fff'; for (let y = 8; y < 74; y += 14) for (let x = 8; x < 108; x += 16) fg0.fillRect(x + ((y / 14) % 2 ? 8 : 0) - 2, y, 4, 4);
        const flagTex = texOf(fc);
        [[-42, 0.9], [0, 1.1], [42, 0.9]].forEach(([fx, sc2]) => {
            const th = Math.atan2(fx, 150), r = bowlR(th) + 56;
            const x = r * Math.sin(th), z = -r * Math.cos(th);
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 26, 8), new THREE.MeshStandardMaterial({ color: 0xe8e8ee, roughness: 0.4 }));
            pole.position.set(x, 32 + 13, z); scene.add(pole);
            const g2 = new THREE.PlaneGeometry(11 * sc2, 6.2 * sc2, 12, 4); g2.translate(5.5 * sc2, 0, 0);
            const flag = new THREE.Mesh(g2, new THREE.MeshBasicMaterial({ map: flagTex, side: THREE.DoubleSide }));
            flag.position.set(x, 32 + 22, z); flag.userData.base = g2.attributes.position.array.slice(); flags.push(flag); scene.add(flag);
        });

        // camera-flash sparkles in the crowd
        const n = 260, p = new Float32Array(n * 3), ph = new Float32Array(n), sz = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const th = rnd(-Math.PI * 0.55, Math.PI * 0.55), u = Math.random();
            const r = bowlR(th) + lerp(6, 26, u), y = lerp(4, 11, u);
            p[i * 3] = r * Math.sin(th); p[i * 3 + 1] = y; p[i * 3 + 2] = -r * Math.cos(th);
            ph[i] = rnd(0, 100); sz[i] = rnd(1.5, 3.5);
        }
        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.BufferAttribute(p, 3));
        fg.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
        fg.setAttribute('size', new THREE.BufferAttribute(sz, 1));
        flashPts = new THREE.Points(fg, new THREE.ShaderMaterial({
            uniforms: { time: { value: 0 }, scale: { value: 600 } },
            vertexShader: 'attribute float phase; attribute float size; uniform float time; uniform float scale; varying float vA; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); float s = sin(time*(1.3+fract(phase)*2.0)+phase*7.0); vA = pow(max(0.0,s),40.0); gl_PointSize = size*scale/-mv.z*3.0; gl_Position = projectionMatrix*mv; }',
            fragmentShader: 'varying float vA; void main(){ float d = length(gl_PointCoord-0.5); float a = smoothstep(0.5,0.0,d)*vA; if(a<0.01) discard; gl_FragColor = vec4(1.0,0.97,0.85,a); }',
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        }));
        scene.add(flashPts);
    }

    function drawScoreboard(G, info) {
        if (!scoreboardCtx) return;
        const key = G ? [G.inning, G.half, G.score[0], G.score[1], G.balls, G.strikes, G.outs, info.awayAbbr, info.homeAbbr].join('|') : 'idle';
        if (key === scoreboardKey) return;
        scoreboardKey = key;
        const g = scoreboardCtx, W_ = 1024, H_ = 400;
        g.fillStyle = '#050608'; g.fillRect(0, 0, W_, H_);
        g.strokeStyle = '#2a3042'; g.lineWidth = 8; g.strokeRect(4, 4, W_ - 8, H_ - 8);
        g.textBaseline = 'middle';
        if (!G) { g.fillStyle = '#ffcc33'; g.font = 'bold 120px Arial'; g.textAlign = 'center'; g.fillText('PLAY BALL', W_ / 2, H_ / 2); scoreboardTex.needsUpdate = true; return; }
        g.font = 'bold 84px "PingFang TC","Microsoft JhengHei",Arial';
        const row = (y, abbr, score, col, act) => {
            g.fillStyle = col; g.fillRect(40, y - 44, 16, 88);
            g.fillStyle = act ? '#ffffff' : '#9aa3b8'; g.textAlign = 'left'; g.fillText(abbr, 78, y);
            g.fillStyle = '#ffcc33'; g.textAlign = 'right'; g.font = 'bold 120px Arial'; g.fillText(String(score), 520, y);
            g.font = 'bold 84px "PingFang TC","Microsoft JhengHei",Arial';
        };
        row(110, info.awayAbbr, G.score[0], info.awayCol, G.half === 0);
        row(260, info.homeAbbr, G.score[1], info.homeCol, G.half === 1);
        g.fillStyle = '#33ff88'; g.font = 'bold 90px Arial'; g.textAlign = 'center';
        g.fillText((G.half === 0 ? '▲ ' : '▼ ') + G.inning, 760, 110);
        const dots = (label, y, n, max, col) => {
            g.fillStyle = '#aab'; g.font = 'bold 48px Arial'; g.textAlign = 'left'; g.fillText(label, 640, y);
            for (let i = 0; i < max; i++) { g.beginPath(); g.arc(720 + i * 56, y, 20, 0, Math.PI * 2); g.fillStyle = i < n ? col : '#1c2130'; g.fill(); }
        };
        dots('B', 205, G.balls, 3, '#35e07a'); dots('S', 275, G.strikes, 2, '#ffd23a'); dots('O', 345, G.outs, 2, '#ff4d3a');
        scoreboardTex.needsUpdate = true;
    }

    // ───────────────────────── people ─────────────────────────
    const geo = {};
    // capsule (hemisphere-capped tapered cylinder) whose cap centres sit at y = 0 and y = -len
    function capsuleGeo(len, rTop, rBot, seg = 12) {
        const pts = [];
        for (let i = 0; i <= 6; i++) { const t = (i / 6) * Math.PI / 2; pts.push(new THREE.Vector2(rBot * Math.cos(t), -len - rBot * Math.sin(t))); }
        for (let i = 0; i <= 6; i++) { const t = (i / 6) * Math.PI / 2; pts.push(new THREE.Vector2(rTop * Math.sin(t), rTop * Math.cos(t))); }
        pts.sort((p1, p2) => p1.y - p2.y);
        return new THREE.LatheGeometry(pts, seg);
    }
    // lathe limb from [radius, y] key points (top first); rounded caps at both ends
    function limbGeo(keys, seg = 12) {
        const pts = [], first = keys[0], last = keys[keys.length - 1];
        for (let i = 0; i <= 5; i++) { const t = (i / 5) * Math.PI / 2; pts.push([first[0] * Math.sin(t), first[1] + first[0] * Math.cos(t)]); }
        keys.forEach(k => pts.push(k));
        for (let i = 1; i <= 5; i++) { const t = (i / 5) * Math.PI / 2; pts.push([last[0] * Math.cos(t), last[1] - last[0] * Math.sin(t)]); }
        // smooth the key radii with a Catmull-Rom style resample
        const v = pts.map(q => new THREE.Vector2(q[0], q[1])).sort((p1, p2) => p1.y - p2.y);
        return new THREE.LatheGeometry(v, seg);
    }
    function buildGeos() {
        const pr = [[0, -0.03], [0.15, -0.03], [0.162, 0.03], [0.152, 0.13], [0.17, 0.27], [0.2, 0.42], [0.208, 0.5], [0.185, 0.575], [0.1, 0.625], [0, 0.635]].map(([r, y]) => new THREE.Vector2(r, y));
        geo.torso = new THREE.LatheGeometry(pr, 18);
        geo.upperArm = limbGeo([[0.06, 0], [0.066, -0.07], [0.066, -0.15], [0.054, -0.24], [0.047, -0.29]], 12);
        geo.foreArm = limbGeo([[0.047, 0], [0.05, -0.05], [0.047, -0.11], [0.036, -0.22], [0.033, -0.27]], 12);
        geo.thigh = limbGeo([[0.102, 0], [0.104, -0.08], [0.094, -0.26], [0.078, -0.42], [0.072, -0.46]], 14);
        geo.shin = limbGeo([[0.072, 0], [0.078, -0.1], [0.076, -0.2], [0.058, -0.36], [0.05, -0.44]], 14);
        geo.sock = new THREE.CylinderGeometry(0.084, 0.064, 0.2, 14).translate(0, -0.33, 0);
        geo.ball = new THREE.SphereGeometry(1, 14, 10);
        geo.head = new THREE.SphereGeometry(0.108, 20, 16);
        geo.cap = new THREE.SphereGeometry(0.122, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
        geo.brim = new THREE.CylinderGeometry(0.135, 0.135, 0.012, 18, 1, false, -Math.PI * 0.5, Math.PI);
        geo.neck = new THREE.CylinderGeometry(0.052, 0.058, 0.12, 10).translate(0, 0.65, 0);
        // wooden bat (lathe profile, knob at origin, barrel along +y)
        const prof = [[0.0, 0], [0.024, 0], [0.026, 0.012], [0.013, 0.03], [0.012, 0.2], [0.02, 0.45], [0.032, 0.68], [0.036, 0.8], [0.032, 0.86], [0, 0.86]].map(([r, y]) => new THREE.Vector2(r, y));
        geo.bat = new THREE.LatheGeometry(prof, 12);
    }

    function makePerson(kind) {
        const m = {
            jersey: std(0xffffff), accent: std(0xcccccc), pants: std(0xeeeeee), sock: std(0xcccccc), skin: std(0xe0ac84, { roughness: 0.7 }),
            cap: std(0x222222, { roughness: 0.6 }), shoe: std(0x15151a, { roughness: 0.5 }), glove: std(0x6b3b1a, { roughness: 0.7 }),
            dark: std(0x101014), gear: std(0x1a2238, { roughness: 0.6 }), bat: std(0xc99a5c, { roughness: 0.5 }),
            hand: std(0xe0ac84, { roughness: 0.7 }), sleeve: std(0xffffff), band: std(0xffffff, { roughness: 0.6 }), hair: std(0x17120e, { roughness: 0.9 }), sole: std(0xe6e6ea, { roughness: 0.6 })
        };
        const jerseyC = canvasOf(256, 256), jerseyT = new THREE.CanvasTexture(jerseyC);
        jerseyT.wrapS = THREE.RepeatWrapping; jerseyT.offset.x = 0.5; jerseyT.anisotropy = maxAniso; m.jersey.map = jerseyT;
        const pantsC = canvasOf(64, 128), pantsT = new THREE.CanvasTexture(pantsC); pantsT.anisotropy = maxAniso; m.pants.map = pantsT;
        const root = new THREE.Group();
        const part = (g, mat, parent, shadow = true) => { const me = new THREE.Mesh(g, mat); me.castShadow = shadow; parent.add(me); return me; };
        const blob = (mat, parent, sx, sy, sz, x = 0, y = 0, z = 0) => { const me = new THREE.Mesh(geo.ball, mat); me.scale.set(sx, sy, sz); me.position.set(x, y, z); me.castShadow = true; parent.add(me); return me; };
        const hips = new THREE.Group(); hips.position.y = HIP_Y; root.add(hips);
        blob(m.pants, hips, 0.19, 0.14, 0.14, 0, -0.04, 0);
        const torso = new THREE.Group(); torso.position.y = 0.03; hips.add(torso);
        const torsoMesh = part(geo.torso, m.jersey, torso); torsoMesh.scale.set(1.1, 1, 0.8);
        const belt = part(new THREE.CylinderGeometry(0.157, 0.157, 0.04, 18).translate(0, -0.02, 0), m.dark, torso, false); belt.scale.set(1.1, 1, 0.8);
        const collar = part(new THREE.TorusGeometry(0.075, 0.016, 8, 16), m.accent, torso, false); collar.rotation.x = Math.PI / 2; collar.position.y = 0.625; collar.scale.y = 0.8;
        part(geo.neck, m.skin, torso, false);
        const head = new THREE.Group(); head.position.set(0, 0.74, 0.01); torso.add(head);
        const skull = part(geo.head, m.skin, head); skull.scale.set(0.95, 1.1, 1.02);
        blob(m.skin, head, 0.026, 0.03, 0.03, 0, -0.012, 0.108);              // nose
        blob(m.skin, head, 0.022, 0.034, 0.02, 0.104, -0.005, 0); blob(m.skin, head, 0.022, 0.034, 0.02, -0.104, -0.005, 0); // ears
        blob(m.skin, head, 0.055, 0.04, 0.05, 0, -0.085, 0.05);               // jaw
        [-0.04, 0.04].forEach(x => blob(m.dark, head, 0.013, 0.013, 0.013, x, 0.018, 0.1));   // eyes
        [-0.04, 0.04].forEach(x => { const br = blob(m.dark, head, 0.026, 0.005, 0.01, x, 0.045, 0.098); br.rotation.z = x > 0 ? -0.15 : 0.15; }); // brows
        blob(m.hair, head, 0.094, 0.07, 0.08, 0, 0.0, -0.04);                // hair under the cap
        // cap / helmet
        const capG = new THREE.Group(); head.add(capG);
        const dome = part(geo.cap, m.cap, capG); dome.position.y = 0.034; dome.scale.set(1, 1.0, 1.05);
        const brim = part(geo.brim, m.cap, capG, false); brim.position.set(0, 0.05, 0.06); brim.rotation.x = -0.14; brim.scale.set(0.95, 1, 1.25);
        const flap = part(new THREE.BoxGeometry(0.03, 0.1, 0.11), m.cap, head, false); flap.position.set(0.115, 0.0, 0.0); flap.visible = false;
        // logo on cap front
        const logoC = canvasOf(64, 64), logoT = new THREE.CanvasTexture(logoC);
        const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), new THREE.MeshBasicMaterial({ map: logoT, transparent: true }));
        logo.position.set(0, 0.092, 0.124); logo.rotation.x = -0.3; head.add(logo);
        // face mask for catcher / umpire
        const mask = part(new THREE.TorusGeometry(0.1, 0.012, 6, 16), m.dark, head, false); mask.position.set(0, -0.005, 0.105); mask.visible = false;

        const mkArm = side => {
            const s = side === 'L' ? 1 : -1;
            const sh = new THREE.Group(); sh.position.set(0.235 * s, 0.5, 0); torso.add(sh);
            part(geo.upperArm, m.sleeve, sh).scale.set(1.22, 1, 1.22);
            const el = new THREE.Group(); el.position.y = -0.29; sh.add(el);
            part(geo.foreArm, m.accent, el).scale.set(1.2, 1, 1.2);
            const hand = new THREE.Group(); hand.position.y = -0.285; el.add(hand);
            blob(m.hand, hand, 0.046, 0.058, 0.042, 0, -0.012, 0);
            const wb = part(new THREE.CylinderGeometry(0.041, 0.039, 0.05, 12).translate(0, -0.235, 0), m.band, el, false);
            return { sh, el, hand };
        };
        const armL = mkArm('L'), armR = mkArm('R');
        const mkLeg = side => {
            const s = side === 'L' ? 1 : -1;
            const hp = new THREE.Group(); hp.position.set(0.105 * s, -0.03, 0); hips.add(hp);
            part(geo.thigh, m.pants, hp).scale.set(1.15, 1, 1.15);
            const kn = new THREE.Group(); kn.position.y = -0.46; hp.add(kn);
            part(geo.shin, m.pants, kn).scale.set(1.12, 1, 1.12);
            part(geo.sock, m.sock, kn, false).scale.set(1.12, 1, 1.12);
            const an = new THREE.Group(); an.position.y = -0.44; kn.add(an);
            blob(m.shoe, an, 0.056, 0.05, 0.15, 0, -0.035, 0.06);
            blob(m.sole, an, 0.058, 0.012, 0.152, 0, -0.078, 0.06);
            return { hp, kn, an };
        };
        const legL = mkLeg('L'), legR = mkLeg('R');

        // glove (left hand) + bat holder + catcher gear
        const gloveG = new THREE.Group(); armL.hand.add(gloveG);
        const gm = part(geo.ball, m.glove, gloveG); gm.scale.set(0.095, 0.115, 0.06); gm.position.set(0, -0.03, 0.04);
        const gm2 = part(geo.ball, m.glove, gloveG); gm2.scale.set(0.06, 0.1, 0.045); gm2.position.set(0.03, 0.03, 0.04);
        gloveG.visible = false;
        const holder = new THREE.Group(); torso.add(holder);
        const bat = part(geo.bat, m.bat, holder); holder.visible = false;
        const chest = part(new THREE.BoxGeometry(0.44, 0.5, 0.26), m.gear, torso); chest.position.set(0, 0.3, 0.02); chest.visible = false;
        const shinGuardL = part(new THREE.BoxGeometry(0.1, 0.34, 0.09), m.gear, legL.kn, false); shinGuardL.position.set(0, -0.22, 0.07); shinGuardL.visible = false;
        const shinGuardR = shinGuardL.clone(); legR.kn.add(shinGuardR);
        // jersey number plate on the back
        const numC = canvasOf(128, 128), numT = new THREE.CanvasTexture(numC);
        const num = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ map: numT, transparent: true }));
        num.position.set(0, 0.33, -0.178); num.rotation.y = Math.PI; torso.add(num); num.visible = false;

        const p = { kind, root, hips, torso, head, armL, armR, legL, legR, mats: m, jerseyC, jerseyT, pantsC, pantsT, capG, flap, mask, logoC, logoT, numC, numT, num, gloveG, holder, bat, chest, shinGuardL, shinGuardR, brim, belt, fade: 1, teamKey: '' };
        p.allMats = Object.values(m);
        root.traverse(o => { if (o.isMesh) o.frustumCulled = true; });
        scene.add(root);
        return p;
    }

    function setFade(p, a) {
        if (Math.abs(p.fade - a) < 0.005) return;
        p.fade = a;
        const t = a < 0.995;
        p.allMats.forEach(mt => { mt.transparent = t; mt.opacity = a; mt.depthWrite = !t; mt.needsUpdate = true; });
    }

    function dressTeam(p, team, isHome, opts = {}) {
        const key = [team.abbr, isHome, opts.helmet, opts.number, p.skinKey].join('|');
        if (p.teamKey === key) return; p.teamKey = key;
        const jl = lum(team.jersey || '#ffffff');
        const jersey = isHome ? (team.jersey || '#ffffff') : (jl > 0.8 ? '#c4c9d2' : (team.jersey || '#c4c9d2'));
        const c2 = team.c2 && team.c2.toLowerCase() !== '#ffffff' ? team.c2 : team.c1;
        p.mats.jersey.color.set(0xffffff); p.mats.pants.color.set(0xffffff); p.mats.sleeve.color.set(jersey);
        p.mats.accent.color.set(isHome ? (jl > 0.6 ? '#f1f1f4' : c2) : c2);
        p.mats.band.color.set(c2);
        const pantsHex = isHome ? '#f3f3f6' : '#c9ced8';
        // jersey texture: front lettering, side piping, subtle fabric noise
        {
            const g = p.jerseyC.getContext('2d'), w = 256, h = 256, pipe = lum(c2) > 0.85 ? team.c1 : c2;
            g.fillStyle = jersey; g.fillRect(0, 0, w, h);
            for (let i = 0; i < 700; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.035)'; g.fillRect(Math.random() * w, Math.random() * h, 3, 2); }
            g.fillStyle = pipe; [0.25, 0.75].forEach(f => g.fillRect(f * w - 2.5, 0, 5, h));
            g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, h - 10, w, 10);
            const lt = (team.abbr || '').length;
            g.font = 'bold ' + (lt <= 2 ? 58 : lt === 3 ? 46 : 36) + 'px "PingFang TC","Microsoft JhengHei",Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.lineWidth = 6; g.strokeStyle = pipe; g.lineJoin = 'round'; g.strokeText(team.abbr || '', w / 2, 112);
            g.fillStyle = lum(jersey) > 0.6 ? team.c1 : '#ffffff'; g.fillText(team.abbr || '', w / 2, 112);
            g.strokeStyle = pipe; g.lineWidth = 4; g.beginPath(); g.moveTo(w / 2 - 22, 12); g.lineTo(w / 2, 36); g.lineTo(w / 2 + 22, 12); g.stroke();   // collar V
            p.jerseyT.needsUpdate = true;
            const q = p.pantsC.getContext('2d'); q.fillStyle = pantsHex; q.fillRect(0, 0, 64, 128);
            q.fillStyle = pipe; [16, 48].forEach(x => q.fillRect(x - 2, 0, 4, 128));
            for (let i = 0; i < 200; i++) { q.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)'; q.fillRect(Math.random() * 64, Math.random() * 128, 2, 3); }
            p.pantsT.needsUpdate = true;
        }
        p.gloves = !!opts.helmet; p.mats.hand.color.set(p.gloves ? 0xf4f4f6 : (p.skinColor || 0xe0ac84));
        p.mats.sock.color.set(c2);
        p.mats.cap.color.set(team.c1);
        p.flap.visible = !!opts.helmet;
        p.mats.cap.roughness = opts.helmet ? 0.22 : 0.7; p.mats.cap.metalness = opts.helmet ? 0.15 : 0;
        // cap logo
        const g = p.logoC.getContext('2d'); g.clearRect(0, 0, 64, 64);
        const hc = lum(team.c1) > 0.5 ? '#111' : '#fff';
        g.fillStyle = hc; g.font = 'bold ' + ((team.hatLogo || '').length > 1 ? 30 : 42) + 'px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(team.hatLogo || '', 32, 34); p.logoT.needsUpdate = true;
        if (opts.number != null) {
            const n = p.numC.getContext('2d'); n.clearRect(0, 0, 128, 128);
            n.fillStyle = lum(jersey) > 0.55 ? (lum(team.c1) > 0.7 ? '#222' : team.c1) : '#fff';
            n.font = 'bold 84px Arial'; n.textAlign = 'center'; n.textBaseline = 'middle'; n.fillText(String(opts.number), 64, 70);
            p.numT.needsUpdate = true; p.num.visible = true;
        } else p.num.visible = false;
    }

    function setSkin(p, name) {
        const tones = [0xf1c9a3, 0xe0ac84, 0xc98f63, 0xa8704a, 0x8a5a3a];
        const k = hash(name || '') % tones.length; p.skinKey = k; p.skinColor = tones[k]; p.mats.skin.color.set(tones[k]); p.mats.hand.color.set(p.gloves ? 0xf4f4f6 : tones[k]);
    }

    // ───────────── poses ─────────────
    // angles in rad. hip*/shoulder* positive = limb swings forward. knee/elbow positive = flex.
    function applyPose(p, P) {
        p.hips.position.y = HIP_Y - (P.crouch || 0);
        p.hips.rotation.set(P.hipsX || 0, P.hipsY || 0, P.hipsZ || 0);
        p.torso.rotation.set(P.torsoX || 0, P.torsoY || 0, P.torsoZ || 0);
        p.head.rotation.set(P.headX || 0, P.headY || 0, 0);
        const leg = (l, f, k, ab) => { l.hp.rotation.set(-f, 0, ab); l.kn.rotation.x = k; l.an.rotation.x = f - k; };
        leg(p.legL, P.hipL || 0, P.kneeL || 0, P.spreadL || 0);
        leg(p.legR, P.hipR || 0, P.kneeR || 0, -(P.spreadR || 0));
        const arm = (a, f, e, ab) => { a.sh.rotation.set(-f, 0, ab); a.el.rotation.set(-e, 0, 0); };
        arm(p.armL, P.armL || 0.05, P.elbL || 0.15, P.absL || 0.05);
        arm(p.armR, P.armR || 0.05, P.elbR || 0.15, -(P.absR || 0.05));
    }
    function lerpPose(a, b, t) {
        const o = {}; const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        keys.forEach(k => {
            const va = a[k], vb = b[k];
            if (Array.isArray(va) || Array.isArray(vb)) { const A = va || vb, B = vb || va; o[k] = [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)]; }
            else o[k] = lerp(va || 0, vb || 0, t);
        });
        return o;
    }
    function keyPose(keys, t) { // keys: [[t0,pose],...] sorted
        if (t <= keys[0][0]) return keys[0][1];
        for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) { const [t0, a] = keys[i - 1], [t1, b] = keys[i]; return lerpPose(a, b, ease((t - t0) / (t1 - t0))); }
        return keys[keys.length - 1][1];
    }

    // two-bone IK: aim arm so its hand reaches worldTarget; hint = elbow direction (world)
    const _S = new THREE.Vector3(), _D = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Vector3(), _U = new THREE.Vector3(), _F = new THREE.Vector3(), _A = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3(), _E = new THREE.Vector3();
    const _M = new THREE.Matrix4(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion();
    function ikArm(arm, target, hint) {
        const a = 0.29, b = 0.31;
        arm.sh.getWorldPosition(_S);
        _D.copy(target).sub(_S);
        let d = _D.length(); if (d < 1e-4) return;
        _D.multiplyScalar(1 / d);
        d = clamp(d, Math.abs(a - b) + 0.02, a + b - 0.004);
        const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), alpha = Math.acos(cosA);
        _n.crossVectors(_D, hint); if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0); _n.normalize();
        _e.crossVectors(_n, _D).normalize();
        _U.copy(_D).multiplyScalar(Math.cos(alpha)).addScaledVector(_e, Math.sin(alpha)).normalize();
        _E.copy(_S).addScaledVector(_U, a);
        _F.copy(_S).addScaledVector(_D, d).sub(_E).normalize();
        _A.crossVectors(_U, _F); let beta = Math.acos(clamp(_U.dot(_F), -1, 1));
        if (_A.lengthSq() < 1e-8) { _A.copy(_n); beta = 0; } _A.normalize();
        _Y.copy(_U).multiplyScalar(-1);
        _Z.crossVectors(_A, _Y);
        _M.makeBasis(_A, _Y, _Z); _q.setFromRotationMatrix(_M);
        arm.sh.parent.getWorldQuaternion(_pq);
        arm.sh.quaternion.copy(_pq.invert().multiply(_q));
        arm.el.rotation.set(beta, 0, 0);
    }
    const _hintDown = new THREE.Vector3(0, -1, 0);
    const _tmpW = new THREE.Vector3();

    // ───────────────────────── scene actors ─────────────────────────
    const actors = { fielders: [], pitcher: null, catcher: null, umpire: null, batter: null, batterWrap: null, runners: [null, null, null], extras: [] };
    const FIELD_POS = [
        { k: '1B', x: 17.5, z: -21 }, { k: '2B', x: 9.8, z: -33 }, { k: 'SS', x: -9.8, z: -33 }, { k: '3B', x: -17.5, z: -21 },
        { k: 'LF', x: -37, z: -74 }, { k: 'CF', x: 0, z: -90 }, { k: 'RF', x: 37, z: -74 }
    ];
    let ball, hitBall, ballShadow, trail = [], flashSprite, glowTex, mitt, mittT = 0;
    let particles = [];

    function ballTexture() {
        const c = canvasOf(128, 64), g = c.getContext('2d');
        g.fillStyle = '#f7f4ec'; g.fillRect(0, 0, 128, 64);
        g.strokeStyle = '#c4222c'; g.lineWidth = 3;
        for (const cx of [32, 96]) { g.beginPath(); g.arc(cx - 18, 32, 22, -1.0, 1.0); g.stroke(); g.beginPath(); g.arc(cx + 18, 32, 22, Math.PI - 1.0, Math.PI + 1.0); g.stroke(); }
        const t = new THREE.CanvasTexture(c); return t;
    }

    function buildActors() {
        buildGeos();
        for (const f of FIELD_POS) {
            const p = makePerson('field'); p.gloveG.visible = true; p.root.position.set(f.x, 0, f.z);
            p.home = { x: f.x, z: f.z }; p.cur = { x: f.x, z: f.z }; p.pos = f.k; p.phase = rnd(0, 6.28); p.chase = null; p.speed = 0;
            actors.fielders.push(p);
        }
        const pit = makePerson('pitcher'); pit.gloveG.visible = true; pit.root.position.set(0, 0.26, MOUND_Z + 0.1); pit.root.rotation.y = 0; actors.pitcher = pit;
        const cat = makePerson('catcher'); cat.chest.visible = true; cat.mask.visible = true; cat.shinGuardL.visible = cat.shinGuardR.visible = true; cat.gloveG.visible = true;
        cat.root.position.set(0, 0, 0.95); cat.root.rotation.y = Math.PI; actors.catcher = cat;
        cat.mats.cap.color.set(0x1a2238); cat.mats.jersey.color.set(0x1a2238); cat.flap.visible = true;
        const ump = makePerson('ump'); ump.mats.jersey.color.set(0x15181f); ump.mats.accent.color.set(0x15181f); ump.mats.pants.color.set(0x6d717a); ump.mats.sock.color.set(0x111111);
        ump.mats.cap.color.set(0x15181f); ump.mask.visible = true; ump.chest.visible = true; ump.root.position.set(0.0, 0, 2.05); ump.root.rotation.y = Math.PI; actors.umpire = ump;
        ump.logoC.getContext('2d').clearRect(0, 0, 64, 64);

        const wrap = new THREE.Group(); scene.add(wrap); actors.batterWrap = wrap;
        const bt = makePerson('batter'); scene.remove(bt.root); wrap.add(bt.root);
        bt.root.position.set(-0.95, 0, 0.05); bt.root.rotation.y = Math.PI / 2; bt.holder.visible = true; bt.flap.visible = true; actors.batter = bt;

        for (let i = 0; i < 3; i++) { const r = makePerson('runner'); r.root.visible = false; r.hold = i; actors.extras.push(r); }

        // ball
        const bm = new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.55, emissive: 0x333330, emissiveIntensity: 0.55 });
        ball = new THREE.Mesh(geo.ball, bm); ball.scale.setScalar(0.052); ball.castShadow = true; ball.visible = false; scene.add(ball);
        hitBall = new THREE.Mesh(geo.ball, bm); hitBall.scale.setScalar(0.06); hitBall.castShadow = true; hitBall.visible = false; scene.add(hitBall);
        for (let i = 0; i < 8; i++) {
            const t = new THREE.Mesh(geo.ball, new THREE.MeshBasicMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.2, depthWrite: false }));
            t.visible = false; scene.add(t); trail.push(t);
        }
        const sc = canvasOf(64, 64), sg = sc.getContext('2d'); const gr = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); sg.fillStyle = gr; sg.fillRect(0, 0, 64, 64);
        ballShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
        ballShadow.rotation.x = -Math.PI / 2; ballShadow.position.y = 0.03; ballShadow.visible = false; scene.add(ballShadow);
        // floating catcher's mitt: the visible "target" in the batter camera
        mitt = new THREE.Group();
        const mm = new THREE.MeshStandardMaterial({ color: 0x7a4420, roughness: 0.6 });
        const mb = new THREE.Mesh(geo.ball, mm); mb.scale.set(0.17, 0.19, 0.075); mitt.add(mb);
        const ml = new THREE.Mesh(geo.ball, new THREE.MeshStandardMaterial({ color: 0xc9a06a, roughness: 0.7 })); ml.scale.set(0.1, 0.11, 0.03); ml.position.z = -0.05; mitt.add(ml);
        const lace = new THREE.MeshStandardMaterial({ color: 0x2a1608, roughness: 0.8 });
        for (let i = -1; i <= 1; i += 0.5) { const f = new THREE.Mesh(geo.ball, lace); f.scale.set(0.006, 0.12, 0.004); f.position.set(i * 0.06, 0.02, 0.078); mitt.add(f); }
        const th = new THREE.Mesh(geo.ball, mm); th.scale.set(0.05, 0.1, 0.06); th.position.set(0.15, -0.02, 0); th.rotation.z = -0.5; mitt.add(th);
        mitt.traverse(o => { if (o.isMesh) o.castShadow = false; });
        mitt.visible = false; scene.add(mitt);
        glowTex = glowTexture();
        flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
        flashSprite.scale.set(1.4, 1.4, 1); scene.add(flashSprite);
    }

    // ───────────────────────── camera rig ─────────────────────────
    const camS = { pos: new THREE.Vector3(0, 1.6, 7.4), look: new THREE.Vector3(0, ZONE_Y, 0), fov: 25, shift: 100 };
    const BAT_CAM = { pos: new THREE.Vector3(0, 1.6, 7.4), look: new THREE.Vector3(0, ZONE_Y, 0), shift: 100 };
    BAT_CAM.fov = 2 * Math.atan(GH / (2 * BAT_CAM.pos.distanceTo(BAT_CAM.look) * K)) * 180 / Math.PI;

    function applyCamera(cam, st) {
        cam.position.copy(st.pos); cam.fov = st.fov; cam.aspect = rect.w / rect.h;
        const sh = st.shift * rect.h / GH;
        cam.setViewOffset(rect.w, rect.h, -rect.x, -rect.y - sh, cw, ch);
        cam.lookAt(st.look); cam.updateMatrixWorld(true);
    }
    function pxToPlane(sx, sy, out) {
        const nx = ((rect.x + sx / GW * rect.w) / cw) * 2 - 1, ny = -(((rect.y + sy / GH * rect.h) / ch) * 2 - 1);
        _D.set(nx, ny, 0.5).unproject(zoneCam).sub(zoneCam.position).normalize();
        const t = -zoneCam.position.z / _D.z;
        return (out || new THREE.Vector3()).copy(zoneCam.position).addScaledVector(_D, t);
    }

    function resize(winW, winH, gameRect) {
        if (!renderer) return;
        cw = winW; ch = winH; rect = { x: gameRect.x, y: gameRect.y, w: gameRect.w, h: gameRect.h };
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(cw, ch, false);
        canvas3d.style.width = cw + 'px'; canvas3d.style.height = ch + 'px';
        applyCamera(zoneCam, { pos: BAT_CAM.pos, look: BAT_CAM.look, fov: BAT_CAM.fov, shift: BAT_CAM.shift });
        if (flashPts) flashPts.material.uniforms.scale.value = ch * 0.5;
    }

    // ───────────────────────── gameplay state ─────────────────────────
    const S = {
        lastT: 0, lastFrame: null, hitFrame: null, flight: null, lastBallFrame: -1, mitt: new THREE.Vector3(0, ZONE_Y, 0.2),
        lastWu: 0, runnersPrev: [false, false, false], camMode: 'bat', lastPhase: -1, shake: 0, birth: performance.now(), celebrate: 0
    };

    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();

    function faceToward(p, x, z) { const dx = x - p.root.position.x, dz = z - p.root.position.z; if (dx * dx + dz * dz > 1e-6) p.root.rotation.y = Math.atan2(dx, dz); }

    // pose library -------------------------------------------------
    const P_FIELD = { crouch: 0.16, hipsX: 0, torsoX: 0.45, hipL: 0.5, hipR: 0.5, kneeL: 0.85, kneeR: 0.85, spreadL: 0.12, spreadR: 0.12, armL: 0.9, elbL: 0.5, armR: 0.8, elbR: 0.6, absL: 0.25, absR: 0.25 };
    const P_STAND = { torsoX: 0.05, armL: 0.1, armR: 0.1, elbL: 0.2, elbR: 0.2 };
    const P_LEAD = { crouch: 0.18, torsoX: 0.42, hipL: 0.45, hipR: 0.45, kneeL: 0.9, kneeR: 0.9, spreadL: 0.14, spreadR: 0.14, armL: 0.5, armR: 0.5, elbL: 0.7, elbR: 0.7, absL: 0.2, absR: 0.2 };
    const P_CROUCH = { crouch: 0.46, torsoX: 0.28, hipL: 1.5, hipR: 1.5, kneeL: 2.2, kneeR: 2.2, spreadL: 0.45, spreadR: 0.45, armL: 0.9, elbL: 0.3, armR: 0.6, elbR: 0.5, absL: 0.2, absR: 0.2 };
    const P_UMP = { crouch: 0.12, torsoX: 0.5, hipL: 0.5, hipR: 0.5, kneeL: 0.5, kneeR: 0.5, spreadL: 0.1, spreadR: 0.1, armL: 0.5, elbL: 0.2, armR: 0.5, elbR: 0.2, absL: 0.1, absR: 0.1 };
    const P_SET = { crouch: 0.05, torsoX: 0.2, headX: -0.1, hipL: 0.14, hipR: 0.1, kneeL: 0.3, kneeR: 0.26, spreadL: 0.1, spreadR: 0.1 };
    const P_WIND = [
        [0, P_SET],
        [0.55, { torsoX: -0.06, hipL: 1.0, kneeL: 1.25, hipR: 0.05, kneeR: 0.15, spreadL: 0.05, spreadR: 0.1, handHigh: 1 }],
        [1, { torsoX: -0.22, hipL: 1.5, kneeL: 1.5, hipR: 0.12, kneeR: 0.3, spreadL: 0.05, spreadR: 0.1, handHigh: 2, rootZ: 0.0 }]
    ];
    const P_REL = { torsoX: 0.72, hipL: 0.95, kneeL: 0.35, hipR: -0.35, kneeR: 0.7, spreadL: 0.12, spreadR: 0.12, crouch: 0.1, handHigh: 3, rootZ: 0.85 };
    const P_FOLLOW = { torsoX: 0.95, hipL: 0.8, kneeL: 0.5, hipR: -0.1, kneeR: 0.9, spreadL: 0.12, spreadR: 0.12, crouch: 0.14, handHigh: 4, rootZ: 0.95 };

    function pitcherHands(p, hh, t) {
        // returns [rightHandTarget, leftHandTarget] in pitcher-local coords (forward = +z)
        const lerpV = (a, b, t_) => [lerp(a[0], b[0], t_), lerp(a[1], b[1], t_), lerp(a[2], b[2], t_)];
        const setR = [-0.03, 1.28, 0.3], setL = [0.03, 1.3, 0.3];
        const high = [[-0.05, 1.95, 0.2], [0.05, 1.9, 0.2]];
        const cock = [[-0.42, 1.55, -0.42], [0.32, 1.55, 0.55]];
        const rel = [[-0.25, 2.1, 0.55], [0.3, 1.45, 0.5]];
        const fol = [[0.2, 0.95, 0.65], [0.15, 1.35, 0.3]];
        if (hh <= 1) return [lerpV(setR, high[0], hh), lerpV(setL, high[1], hh)];
        if (hh <= 2) return [lerpV(high[0], cock[0], hh - 1), lerpV(high[1], cock[1], hh - 1)];
        if (hh <= 3) return [lerpV(cock[0], rel[0], hh - 2), lerpV(cock[1], rel[1], hh - 2)];
        return [lerpV(rel[0], fol[0], clamp(hh - 3, 0, 1)), lerpV(rel[1], fol[1], clamp(hh - 3, 0, 1))];
    }

    function updatePitcher(G, info, df) {
        const p = actors.pitcher;
        let P, hh = 0;
        const f = G.ballActive ? (G.frame - G.ballFrame) : 999;
        const humanPitching = info.humanPitching;
        let wu = 0;
        if (humanPitching && (G.phase === info.PH.POWER_GAUGE || G.phase === info.PH.AIM)) wu = G.phase === info.PH.POWER_GAUGE ? G.gaugePos : 0;
        else if (!humanPitching && G.phase === info.PH.WAIT_PITCH) wu = clamp((46 - G.phaseTimer) / 46, 0, 1);
        if (wu > 0) S.lastWu = wu;
        let rootZ = 0;
        if (f < 4) {
            const w = S.lastWu; const A = keyPose(P_WIND, w), t = ease(clamp(f / 4, 0, 1));
            P = lerpPose(A, P_REL, t); hh = lerp(1 + w, 3, t);
            rootZ = lerp(A.rootZ || 0, P_REL.rootZ, t);
        } else if (f < 28) {
            const t = ease((f - 4) / 24); P = lerpPose(P_REL, P_FOLLOW, t); hh = 3 + t; rootZ = lerp(P_REL.rootZ, P_FOLLOW.rootZ, t);
        } else if (f < 70) {
            const t = ease((f - 28) / 42); P = lerpPose(P_FOLLOW, P_SET, t); hh = 4 - t * 4; rootZ = lerp(P_FOLLOW.rootZ, 0, t);
        } else { P = keyPose(P_WIND, wu); hh = (wu > 0) ? (wu <= 0.55 ? wu / 0.55 : 1 + (wu - 0.55) / 0.45) : 0; rootZ = P.rootZ || 0; S.lastWu = wu > 0 ? S.lastWu : 0; }
        p.root.position.z = MOUND_Z + 0.1 + rootZ;
        applyPose(p, P);
        p.root.updateMatrixWorld(true);
        const [hr, hl] = pitcherHands(p, hh, 0);
        p.root.localToWorld(v1.set(hr[0], hr[1], hr[2])); p.root.localToWorld(v2.set(hl[0], hl[1], hl[2]));
        ikArm(p.armR, v1, _hintDown.set(-0.4, -1, -0.2));
        ikArm(p.armL, v2, _hintDown.set(0.5, -1, 0));
        _hintDown.set(0, -1, 0);
        p.handWorld = v1.clone();
    }

    function updateCatcher(G, info, dt) {
        const p = actors.catcher;
        // mitt target: aim spot while a human pitches, ball landing spot once thrown
        let tgt = _tmpW.set(0, ZONE_Y, 0);
        if (info.humanPitching && (G.phase === info.PH.AIM || G.phase === info.PH.POWER_GAUGE) && G.aimState !== 0)
            pxToPlane(SZX + G.aimX * 55, SZY + G.aimY * 55, tgt);
        if (G.ballActive && G.frame - G.ballFrame < 200) {
            const t = clamp((G.frame - G.ballFrame) / G.ballDur, 0, 1);
            const bw = pitchWorld(G, 1, v3); tgt.copy(bw);
        }
        S.mitt.x = damp(S.mitt.x, tgt.x, 14, dt); S.mitt.y = damp(S.mitt.y, tgt.y, 14, dt);
        applyPose(p, P_CROUCH);
        p.torso.rotation.x = 0.55;
        p.root.updateMatrixWorld(true);
        v1.set(S.mitt.x, S.mitt.y, 0.22);
        ikArm(p.armL, v1, _hintDown.set(0.4, -1, 0));
        v2.set(-0.12, 0.65, 0.5); ikArm(p.armR, v2, _hintDown.set(-0.5, -1, 0.3));
        _hintDown.set(0, -1, 0);
        // catcher faces the pitcher: glove side is world +x? (root rotated by PI -> local +x = world -x)
    }

    // ── pitch ball ───────────────────────────────────────
    const REL = new THREE.Vector3(-0.28, 1.92, MOUND_Z + 1.4);
    function pitchWorld(G, t, out) {
        pxToPlane(G.ballEX, G.ballEY, out);
        out.x += (G.ballCX / K) * t;
        out.y += -(G.ballCY / K) * t;
        out.z = 0;
        const end = out.clone();
        out.copy(REL).lerp(end, t);
        out.y += Math.sin(t * Math.PI) * 0.06;
        return out;
    }

    function updateBall(G, info, dt, df) {
        const phase = G.phase, PH = info.PH;
        // pitched ball
        const contact = G.hitEffectFrame > G.ballFrame && G.hitEffectFrame > 0;
        let show = G.ballActive && !contact;
        if (show) {
            const t = clamp(info.ballProgress, 0, 1);
            if (G.frame - G.ballFrame < 0) show = false;
            if (show) {
                pitchWorld(G, t, ball.position);
                ball.rotation.x -= 0.5 * df; ball.rotation.z += 0.12 * df;
                ball.visible = true;
                // trail
                for (let i = 0; i < trail.length; i++) {
                    const tt = t - (i + 1) * 0.04;
                    if (tt <= 0 || t >= 1) { trail[i].visible = false; continue; }
                    pitchWorld(G, tt, trail[i].position); trail[i].visible = true;
                    trail[i].scale.setScalar(0.05 * (1 - i * 0.08)); trail[i].material.opacity = 0.16 * (1 - i / trail.length);
                }
                if (t >= 1) { for (const tr of trail) tr.visible = false; }
            }
        }
        if (!show) { ball.visible = false; if (!S.flight) for (const tr of trail) tr.visible = false; }
        // overlay catcher-mitt contact
        if (show && info.ballProgress >= 1) { ball.position.z = 0.22; }
    }

    // ── batted ball ──────────────────────────────────────
    function startFlight(G, info) {
        const type = G.hitType; if (!type) return;
        const R = Math.random;
        const th = clamp(G.hitFlyDir * 0.5, -0.72, 0.72);
        const dir = new THREE.Vector3(Math.sin(th), 0, -Math.cos(th));
        const start = new THREE.Vector3(clamp(G.curX, -1.5, 1.5) * 0.31, 0.85, -0.15);
        let kind, dist, apex, dur, roll = 0, rollDist = 0;
        if (type === 'HR') { kind = 'fly'; dist = bowlR(th) + 18; apex = 38; dur = 112; }
        else if (type === '2B') { kind = 'fly'; dist = 78 + R() * 12; apex = 22; dur = 76; roll = 36; rollDist = 18; }
        else if (type === '1B') {
            if (R() < 0.5) { kind = 'grounder'; dist = 42; apex = 0.9; dur = 52; roll = 30; rollDist = 18; }
            else { kind = 'fly'; dist = 36 + R() * 14; apex = 9; dur = 40; roll = 28; rollDist = 14; }
        } else { // OUT: kind follows the rules decision (fly = sac-fly candidate, ground = grounder)
            if (G.outKind === 'ground') { kind = 'grounder'; dist = 26 + R() * 8; apex = 0.7; dur = 30; }
            else if (R() < 0.75) { kind = 'fly'; dist = 55 + R() * 28; apex = 30; dur = 84; }
            else { kind = 'fly'; dist = 13 + R() * 6; apex = 26; dur = 68; }
        }
        const end = start.clone().addScaledVector(dir, dist); end.y = 0;
        const landing = end.clone();
        const fl = { t0: G.frame, type, kind, start, dir, dist, apex, dur, roll, rollDist, end, landing, catch: type === 'OUT', fielder: null, arrive: 0, spin: rnd(0.3, 0.9) };
        // choose a fielder (nearest, for the ball's resting point)
        const rest = roll ? end.clone().addScaledVector(dir, rollDist) : end;
        let best = null, bd = 1e9;
        actors.fielders.forEach(f => { const d = Math.hypot(f.home.x - rest.x, f.home.z - rest.z); if (d < bd) { bd = d; best = f; } });
        if (type !== 'HR') {
            fl.fielder = best; fl.rest = rest;
            const tx = fl.catch ? end.x : rest.x, tz = fl.catch ? end.z : rest.z;
            best.chase = { tx, tz, t0: G.frame, arrive: G.frame + (fl.catch ? dur - 2 : dur + roll + 6) };
        }
        S.flight = fl;
        // contact flash + shake
        flashSprite.position.copy(start); flashSprite.material.opacity = 1; S.flashT = 0;
        S.shake = type === 'HR' ? 0.9 : 0.5;
        if (type === 'HR') S.celebrate = 1;
    }

    function flightPos(fl, f, out) {
        const t = f - fl.t0;
        const air = t / fl.dur;
        if (air < 1) {
            const h = fl.kind === 'grounder' ? Math.abs(Math.sin(air * Math.PI * (fl.dist / 9))) * fl.apex * (1 - air * 0.6) : 4 * fl.apex * air * (1 - air);
            out.copy(fl.start).addScaledVector(fl.dir, fl.dist * (fl.kind === 'grounder' ? 1 - Math.pow(1 - air, 1.6) : air));
            out.y = fl.start.y * (1 - air) + h + 0.075; return out;
        }
        if (fl.roll) {
            const r = clamp((t - fl.dur) / fl.roll, 0, 1);
            out.copy(fl.end).addScaledVector(fl.dir, fl.rollDist * easeOut(r)); out.y = 0.075 + Math.abs(Math.sin(r * 9)) * 0.25 * (1 - r); return out;
        }
        out.copy(fl.end); out.y = 0.075; return out;
    }

    function updateFlight(G, info, dt) {
        if (S.hitFrame !== G.hitEffectFrame) { S.hitFrame = G.hitEffectFrame; if (G.hitEffectFrame > 0 && G.hitType) startFlight(G, info); }
        const fl = S.flight;
        if (!fl) { hitBall.visible = false; ballShadow.visible = false; return; }
        const t = G.frame - fl.t0;
        if (t < 0) { hitBall.visible = false; return; }
        flightPos(fl, G.frame, hitBall.position);
        hitBall.visible = true;
        hitBall.rotation.x += 0.4; hitBall.rotation.z += 0.2;
        // catch: ball sticks to the fielder's glove
        if (fl.catch && t >= fl.dur - 1 && fl.fielder) {
            const f = fl.fielder; f.gloveG.getWorldPosition(v1); hitBall.position.copy(v1);
        }
        if (fl.type === 'HR' && t > fl.dur) { hitBall.visible = false; }
        // shadow
        const air = t < fl.dur;
        ballShadow.visible = hitBall.visible && !(fl.type === 'HR' && t > fl.dur * 0.97);
        ballShadow.position.set(hitBall.position.x, 0.03, hitBall.position.z);
        const hs = 1 + hitBall.position.y * 0.12; ballShadow.scale.set(0.4 * hs, 0.4 * hs, 1);
        ballShadow.material.opacity = clamp(1 - hitBall.position.y / 40, 0.15, 1);
        // trail
        for (let i = 0; i < trail.length; i++) {
            const tf = G.frame - (i + 1) * 1.6; if (tf < fl.t0 || !air || fl.kind === 'grounder' && false) { trail[i].visible = false; continue; }
            flightPos(fl, tf, trail[i].position); trail[i].visible = true; trail[i].scale.setScalar(0.07 * (1 - i * 0.09)); trail[i].material.opacity = 0.28 * (1 - i / trail.length);
        }
        if (S.flashT !== undefined) { S.flashT += dt; flashSprite.material.opacity = clamp(1 - S.flashT * 5, 0, 1); flashSprite.scale.setScalar(1.2 + S.flashT * 6); }
        if (fl.type === 'HR' && t === Math.round(fl.dur * 0.7)) { /* placeholder for hooks */ }
        // fireworks on HR
        if (fl.type === 'HR' && t > fl.dur * 0.55 && !fl.fw) { fl.fw = true; for (let i = 0; i < 5; i++) setTimeout(() => burst(rnd(-45, 45), rnd(35, 60), -bowlR(0) - rnd(10, 40), [0xffd23a, 0xff5a3a, 0x6ad0ff, 0xffffff][i % 4], 70), i * 260); }
    }

    function burst(x, y, z, color, n) {
        for (let i = 0; i < n; i++) {
            const a = rnd(0, Math.PI * 2), b = Math.acos(rnd(-1, 1)), sp = rnd(6, 16);
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
            s.position.set(x, y, z); s.scale.set(3.2, 3.2, 1); scene.add(s);
            particles.push({ s, v: new THREE.Vector3(Math.sin(b) * Math.cos(a) * sp, Math.cos(b) * sp, Math.sin(b) * Math.sin(a) * sp), life: 1.4 });
        }
    }
    function updateParticles(dt) {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i]; p.life -= dt; p.v.y -= 7 * dt; p.v.multiplyScalar(1 - 0.9 * dt);
            p.s.position.addScaledVector(p.v, dt); p.s.material.opacity = clamp(p.life, 0, 1);
            if (p.life <= 0) { scene.remove(p.s); p.s.material.dispose(); particles.splice(i, 1); }
        }
    }

    // ── fielders ────────────────────────────────────────
    function runPose(P, ph, amp) {
        const s = Math.sin(ph), c = Math.cos(ph);
        P.torsoX = 0.2 * amp; P.hipL = 0.85 * s * amp + 0.1; P.hipR = -0.85 * s * amp + 0.1;
        P.kneeL = 0.3 + 0.9 * Math.max(0, c) * amp; P.kneeR = 0.3 + 0.9 * Math.max(0, -c) * amp;
        P.armL = -0.9 * s * amp; P.armR = 0.9 * s * amp; P.elbL = 1.2; P.elbR = 1.2;
        P.crouch = 0.04 * amp; P.absL = 0.12; P.absR = 0.12;
        return P;
    }

    function updateFielders(G, info, dt, df) {
        const fl = S.flight;
        actors.fielders.forEach((f, i) => {
            let tx = f.home.x, tz = f.home.z, sp = 0.09;
            const inWide = true;
            if (f.chase && fl) {
                const c = f.chase, span = Math.max(1, c.arrive - c.t0), k = clamp((G.frame - c.t0) / span, 0, 1);
                tx = lerp(f.home.x, c.tx, easeOut(k)); tz = lerp(f.home.z, c.tz, easeOut(k)); sp = 0;
                const moving = k < 0.98;
                f.cur.x = tx; f.cur.z = tz; f.root.position.x = tx; f.root.position.z = tz;
                if (moving) faceToward(f, c.tx, c.tz);
                else faceToward(f, 0, 0);
                if (moving) { f.phase += 0.55 * df; applyPose(f, runPose({}, f.phase, 1)); }
                else { f.phase += 0.04 * df; applyPose(f, P_FIELD); }
                f.root.updateMatrixWorld(true);
                if (fl.catch && fl.fielder === f && k >= 0.9) { // glove up to the ball
                    ikArm(f.armL, hitBall.position, _hintDown.set(0.3, -1, 0)); _hintDown.set(0, -1, 0);
                }
                return;
            }
            if (!fl || !f.chase) f.chase = null;
            // drift back home
            const dx = f.home.x - f.cur.x, dz = f.home.z - f.cur.z, d = Math.hypot(dx, dz);
            if (d > 0.05) { const st = Math.min(d, 0.22 * df); f.cur.x += dx / d * st; f.cur.z += dz / d * st; f.root.position.x = f.cur.x; f.root.position.z = f.cur.z; faceToward(f, f.home.x, f.home.z); f.phase += 0.5 * df; applyPose(f, runPose({}, f.phase, 0.9)); }
            else { faceToward(f, 0, 0); f.phase += 0.03 * df; const P = Object.assign({}, P_FIELD); P.crouch += Math.sin(f.phase + i) * 0.015; applyPose(f, P); }
            f.root.visible = true;
        });
    }

    // ── batter ──────────────────────────────────────────
    function updateBatter(G, info, dt, df) {
        const p = actors.batter, wrap = actors.batterWrap;
        const left = info.batter.bats === 'L', mr = left ? -1 : 1;   // mr mirrors the right-handed pose for lefties
        wrap.scale.x = 1;
        p.root.position.x = -0.95 * mr; p.root.rotation.y = mr * Math.PI / 2;
        // swing progress
        let s = -1;
        if (G.batSwingFrame >= 0 && G.frame - G.batSwingFrame < 60) s = (G.frame - G.batSwingFrame) / 20 + 0.28;
        else if (!info.humanBatting && G.aiSwing && G.frame >= G.aiSwingFrame - 8 && G.ballActive) s = (G.frame - (G.aiSwingFrame - 8)) / 20 + 0.28;
        s = s >= 0 ? Math.min(s, 1.4) : -1;
        // right-handed reference pose: front (pitcher-side) leg = left leg
        const stance = { crouch: 0.14, torsoX: 0.22, torsoY: 0.08, hipsY: 0.12, hipL: 0.42, hipR: 0.38, kneeL: 0.78, kneeR: 0.85, spreadL: 0.34, spreadR: 0.34, headY: 1.2, headX: 0.08 };
        let P, hold = { rx: -0.05, rz: 0.55, ry: 0.0, px: -0.1, py: 0.4, pz: 0.12 };
        const wob = Math.sin(G.frame * 0.09) * 0.03;
        if (s < 0) {
            P = Object.assign({}, stance); P.torsoZ = wob; hold.rz += wob;
        } else {
            const T = clamp(s, 0, 1), e = ease(clamp(T / 0.9, 0, 1));
            P = Object.assign({}, stance);
            P.hipsY = lerp(0.12, 1.15, ease(clamp(T / 0.7, 0, 1)));
            P.torsoY = lerp(0.08, 1.3, e);
            P.headY = clamp(1.2 - P.hipsY - P.torsoY, -0.9, 1.3);
            P.hipL = lerp(0.42, 0.7, e); P.kneeL = lerp(0.78, 0.35, e); P.kneeR = lerp(0.85, 1.1, e); P.hipR = lerp(0.38, -0.1, e);
            P.torsoX = lerp(0.22, 0.2, e);
            hold = { rx: lerp(-0.05, -0.12, e), rz: lerp(0.55, -1.52, ease(clamp(T / 0.55, 0, 1))), ry: lerp(0, 0.25, e), px: lerp(-0.1, 0.0, e), py: lerp(0.4, 0.34, e), pz: lerp(0.12, 0.34, e) };
        }
        if (left) { // mirror: swap legs, flip every lateral rotation
            [P.hipL, P.hipR] = [P.hipR, P.hipL]; [P.kneeL, P.kneeR] = [P.kneeR, P.kneeL];
            P.torsoY *= -1; P.hipsY *= -1; P.headY *= -1; P.torsoZ = -(P.torsoZ || 0);
            hold.rz *= -1; hold.ry *= -1; hold.px *= -1;
        }
        applyPose(p, P);
        p.holder.position.set(hold.px, hold.py, hold.pz); p.holder.rotation.set(hold.rx, hold.ry, hold.rz);
        p.root.updateMatrixWorld(true);
        // hands grip the handle: bottom hand = the one on the pitcher side
        p.holder.localToWorld(v1.set(0, 0.05, 0)); p.holder.localToWorld(v2.set(0, 0.19, 0));
        const bottom = left ? p.armR : p.armL, top = left ? p.armL : p.armR;
        ikArm(bottom, v1, _hintDown.set(0.3 * (left ? -1 : 1), -1, 0.3));
        ikArm(top, v2, _hintDown.set(-0.3 * (left ? -1 : 1), -1, 0.3));
        _hintDown.set(0, -1, 0);
    }

    // ── runners ─────────────────────────────────────────
    function updateRunners(G, info, dt, df) {
        const now = G.runners.slice();
        const pool = actors.extras;
        const holdPos = k => { // lead-off spot near base k (0=1B,1=2B,2=3B)
            const b = BASES[k + 1], n = BASES[(k + 2) % 4], d = Math.hypot(n[0] - b[0], n[1] - b[1]);
            return { x: b[0] + (n[0] - b[0]) / d * 1.5 * (k === 2 ? -1 : 1) * (k === 2 ? 1 : 1), z: b[1] + (n[1] - b[1]) / d * 1.5 };
        };
        const spawn = (fromIdx, toK) => {
            const p = pool.find(q => !q.root.visible && !q.runnerBusy); if (!p) return null;
            p.root.visible = true; p.runnerBusy = true; p.target = toK; p.phase = 0; p.path = [];
            const from = BASES[fromIdx]; p.root.position.set(from[0], 0, from[1]);
            for (let b = fromIdx + 1; b <= toK + 1; b++) p.path.push(BASES[b % 4]);
            const hp = holdPos(toK); p.path[p.path.length - 1] = [hp.x, hp.z];
            p.arrived = false; p.slot = toK;
            return p;
        };
        if (!S.runnerObjs) S.runnerObjs = [null, null, null];
        const prev = S.runnersPrev;
        const phaseHR = G.phase === info.PH.HR_RUN;
        if (!phaseHR) {
            let changed = false; for (let k = 0; k < 3; k++) if (prev[k] !== now[k]) changed = true;
            if (changed) {
                const used = [false, false, false];
                const newObjs = [null, null, null];
                for (let j = 2; j >= 0; j--) {
                    if (now[j] && !prev[j]) {
                        let src = -1; for (let k = j - 1; k >= 0; k--) if (prev[k] && !used[k] && S.runnerObjs[k]) { src = k; break; }
                        if (src >= 0) { used[src] = true; const o = S.runnerObjs[src]; o.path = []; for (let b = src + 2; b <= j + 1; b++) o.path.push(BASES[b % 4]); const hp = holdPos(j); if (o.path.length) o.path[o.path.length - 1] = [hp.x, hp.z]; else o.path.push([hp.x, hp.z]); o.arrived = false; newObjs[j] = o; o.slot = j; }
                        else newObjs[j] = spawn(0, j);
                    }
                }
                const leavers = [];
                for (let k = 0; k < 3; k++) {
                    const o = S.runnerObjs[k];
                    if (!o) continue;
                    if (used[k]) { if (now[k] && !newObjs[k]) newObjs[k] = spawn(0, k); continue; }
                    if (now[k]) { if (!newObjs[k]) newObjs[k] = o; } else leavers.push([k, o]);
                }
                // runners who left their base: the most advanced ones score (run home), the rest were put out
                let runs = Math.max(0, G.score[G.half] - (S.prevScore ? S.prevScore[G.half] : 0));
                leavers.sort((x, y) => y[0] - x[0]).forEach(([k, o]) => {
                    if (runs > 0) { runs--; o.path = []; for (let b = k + 2; b <= 4; b++) o.path.push(BASES[b % 4]); o.arrived = false; o.leaving = true; }
                    else releaseRunner(o);
                });
                for (let k = 0; k < 3; k++) if (now[k] && !newObjs[k]) newObjs[k] = spawn(0, k);
                S.runnerObjs = newObjs;
            }
            S.runnersPrev = now;
        } else if (!S.hrHandled) {
            // home run: everyone circles the bases
            S.hrHandled = true;
            S.runnersPrev = [false, false, false];
            const total = 4 * 45;
            const objs = S.runnerObjs.filter(Boolean);
            objs.forEach(o => { const from = o.slot + 1; o.path = []; for (let b = from + 1; b <= 4; b++) o.path.push(BASES[b % 4]); o.arrived = false; o.leaving = true; o.fast = true; });
            const bt = spawn(0, 2); if (bt) { bt.path = [BASES[1], BASES[2], BASES[3], BASES[0]]; bt.arrived = false; bt.leaving = true; bt.fast = true; }
            S.runnerObjs = [null, null, null];
        }
        if (!phaseHR) S.hrHandled = false;
        pool.forEach(o => {
            if (!o.root.visible) return;
            if (!o.path || !o.path.length) { // standing at base
                applyPose(o, P_LEAD); o.phase += 0.05 * df; o.root.position.y = 0;
                faceToward(o, o.root.position.x * 0.5 + 0, o.root.position.z - 8); o.hips.position.y += Math.sin(o.phase) * 0.01;
                return;
            }
            const sp = (o.fast ? 0.62 : 0.34) * df;
            let step = sp;
            while (step > 0 && o.path.length) {
                const tgt = o.path[0], dx = tgt[0] - o.root.position.x, dz = tgt[1] - o.root.position.z, d = Math.hypot(dx, dz);
                if (d <= step) { o.root.position.x = tgt[0]; o.root.position.z = tgt[1]; o.path.shift(); step -= d; }
                else { o.root.position.x += dx / d * step; o.root.position.z += dz / d * step; faceToward(o, tgt[0], tgt[1]); step = 0; }
            }
            o.phase += 0.62 * df; applyPose(o, runPose({}, o.phase, 1));
            if (!o.path.length && o.leaving) releaseRunner(o);
        });
        // colours
        const home = G.half === 1; // bottom half → home team bats
        pool.forEach(o => { if (o.root.visible) dressTeam(o, info.batTeam, home, { helmet: true }); });
    }
    function releaseRunner(o) { o.root.visible = false; o.runnerBusy = false; o.path = []; o.leaving = false; o.fast = false; }

    // ── umpire + catcher teams, colours ─────────────────
    function syncTeams(G, info) {
        const fieldHome = G.half === 0;
        actors.fielders.forEach(f => dressTeam(f, info.pitTeam, fieldHome, {}));
        dressTeam(actors.pitcher, info.pitTeam, fieldHome, {});
        setSkin(actors.pitcher, info.pitcher.name);
        const bs = G.half === 1;
        dressTeam(actors.batter, info.batTeam, bs, { helmet: true, number: G.batOrder[G.half] + 1 });
        setSkin(actors.batter, info.batter.name);
    }

    // ───────────────────────── camera modes ─────────────────────────
    const WIDE = { pos: new THREE.Vector3(0, 13, 22), look: new THREE.Vector3(0, 2, -42), fov: 50, shift: 0 };
    const HRCAM = { pos: new THREE.Vector3(-26, 12, 16), look: new THREE.Vector3(0, 0, -22), fov: 52, shift: 0 };
    const _look = new THREE.Vector3();
    function cameraTarget(G, info) {
        const PH = info.PH; let tgt;
        const fl = S.flight;
        const flying = fl && (G.frame - fl.t0) < fl.dur + fl.roll + 10 && hitBall.visible;
        if (G.phase === PH.HR_RUN || (fl && fl.type === 'HR' && G.phase === PH.RESULT)) {
            if (fl && G.frame - fl.t0 < fl.dur * 0.62) tgt = followCam(fl, G);
            else tgt = HRCAM;
        } else if (flying && G.phase === PH.RESULT) tgt = followCam(fl, G);
        else if (G.phase === PH.RESULT && (G.resSub === 'HIT' || G.resSub === '2 BASE HIT' || G.resSub === 'OUT' || G.resSub === 'WALK')) tgt = flying ? followCam(fl, G) : (G.resSub === 'WALK' ? BAT_CAM : WIDE);
        else if (G.phase === PH.INNING_START) tgt = WIDE;
        else tgt = BAT_CAM;
        return tgt;
    }
    const FOLLOW = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 38, shift: 0 };
    function followCam(fl, G) {
        const b = hitBall.position, far = Math.hypot(b.x, b.z);
        FOLLOW.pos.set(b.x * 0.18, 6 + Math.min(far, 120) * 0.05, 15 + clamp(far * 0.04, 0, 6));
        FOLLOW.look.set(b.x * 0.9, Math.max(1.5, b.y * 0.55), b.z);
        FOLLOW.fov = clamp(30 + far * 0.2, 30, 46);
        return FOLLOW;
    }

    function updateCamera(G, info, dt) {
        if (S.dbgCam) { applyCamera(camera, S.dbgCam); S.nearBat = false; return; }
        const tgt = cameraTarget(G, info);
        const k = tgt === BAT_CAM ? 5.5 : (tgt === FOLLOW ? 7 : 3.2);
        camS.pos.x = damp(camS.pos.x, tgt.pos.x, k, dt); camS.pos.y = damp(camS.pos.y, tgt.pos.y, k, dt); camS.pos.z = damp(camS.pos.z, tgt.pos.z, k, dt);
        camS.look.x = damp(camS.look.x, tgt.look.x, k * 1.2, dt); camS.look.y = damp(camS.look.y, tgt.look.y, k * 1.2, dt); camS.look.z = damp(camS.look.z, tgt.look.z, k * 1.2, dt);
        camS.fov = damp(camS.fov, tgt.fov, k, dt); camS.shift = damp(camS.shift, tgt.shift, k, dt);
        if (tgt === BAT_CAM) { // snap once settled so the zone overlay is pixel-exact
            if (camS.pos.distanceTo(BAT_CAM.pos) < 0.01 && Math.abs(camS.fov - BAT_CAM.fov) < 0.02 && Math.abs(camS.shift - 100) < 0.2) { camS.pos.copy(BAT_CAM.pos); camS.look.copy(BAT_CAM.look); camS.fov = BAT_CAM.fov; camS.shift = 100; }
        }
        const st = { pos: camS.pos, look: camS.look, fov: camS.fov, shift: camS.shift };
        if (S.shake > 0) { S.shake = Math.max(0, S.shake - dt * 2.2); st.pos = camS.pos.clone().add(v3.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(S.shake * 0.05)); }
        applyCamera(camera, st);
        S.camMode = tgt === BAT_CAM ? 'bat' : 'wide';
    }

    // ───────────────────────── title camera ─────────────────────────
    function titleCamera(t) {
        const a = t * 0.12, r = 46;
        camS.pos.set(Math.sin(a) * r * 0.55, 15 + Math.sin(t * 0.2) * 2, 30 + Math.cos(a) * 10); camS.look.set(0, 3, -48); camS.fov = 48; camS.shift = 0;
        applyCamera(camera, camS);
    }

    // ───────────────────────── public API ─────────────────────────
    api.init = function (canvasEl) {
        try {
            canvas3d = canvasEl;
            renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: false, powerPreference: 'high-performance' });
            renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            const small = Math.min(window.innerWidth, window.innerHeight) < 600;
            sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.2, 700);
            zoneCam = new THREE.PerspectiveCamera(30, 4 / 3, 0.2, 700);
            buildStadium(); buildActors();
            api.ok = true;
            api.debug = { scene, camera, renderer, S, actors };
        } catch (e) { console.error('Stadium3D init failed', e); api.ok = false; }
        return api.ok;
    };
    api.debugCam = function (pos, look, fov) { S.dbgCam = pos ? { pos: new THREE.Vector3(...pos), look: new THREE.Vector3(...look), fov: fov || 30, shift: 0 } : null; };
    api.resize = resize;
    api.pxToPlane = pxToPlane;
    api.isBatCam = function () { return !!S.nearBat; };
    api.show = function (v) { if (!api.ok) return; api.visible = v; canvas3d.style.display = v ? 'block' : 'none'; };

    api.renderTitle = function () {
        if (!api.ok) return;
        const now = performance.now(); const dt = Math.min(0.1, (now - (S.lastT || now)) / 1000); S.lastT = now;
        flashPts.material.uniforms.time.value = now / 1000; waveFlags(now / 1000);
        titleCamera((now - S.birth) / 1000);
        updateParticles(dt);
        actors.fielders.forEach(f => { f.root.visible = false; });
        actors.pitcher.root.visible = actors.catcher.root.visible = actors.umpire.root.visible = actors.batterWrap.visible = false;
        actors.extras.forEach(e => e.root.visible = false);
        renderer.render(scene, camera);
    };

    api.frame = function (G, info) {
        if (!api.ok) return;
        const now = performance.now(); const dt = Math.min(0.1, (now - (S.lastT || now)) / 1000); S.lastT = now;
        const df = S.lastFrame === null ? 0 : clamp(G.frame - S.lastFrame, 0, 4); S.lastFrame = G.frame;
        flashPts.material.uniforms.time.value = now / 1000; waveFlags(now / 1000);
        actors.fielders.forEach(f => f.root.visible = true);
        actors.pitcher.root.visible = actors.catcher.root.visible = actors.umpire.root.visible = true;

        syncTeams(G, info);
        drawScoreboard(G, info);
        // batter hides once he becomes a runner
        const hide = G.phase === info.PH.HR_RUN || (G.phase === info.PH.RESULT && ['OUT', 'HIT', '2 BASE HIT', 'WALK', 'HOMERUN'].includes(G.resSub));
        actors.batterWrap.visible = !hide;
        if (G.phase === info.PH.INNING_START || (!G.ballActive && G.phase !== info.PH.RESULT)) { S.flight = null; }
        updateFlight(G, info, dt);
        updatePitcher(G, info, df);
        updateCatcher(G, info, dt);
        applyPose(actors.umpire, P_UMP); actors.umpire.root.updateMatrixWorld(true);
        updateBatter(G, info, dt, df);
        updateFielders(G, info, dt, df);
        updateRunners(G, info, dt, df);
        S.prevScore = G.score.slice();
        updateBall(G, info, dt, df);
        updateParticles(dt);
        updateCamera(G, info, dt);
        // catcher/umpire would cover the strike zone from the batter camera: show only the mitt there
        const nearBat = camS.pos.distanceTo(BAT_CAM.pos) < 3.2 && camS.shift > 60;
        S.nearBat = nearBat && camS.pos.distanceTo(BAT_CAM.pos) < 0.6;
        actors.catcher.root.visible = actors.umpire.root.visible = !nearBat;
        mitt.visible = nearBat;
        if (nearBat) {
            const pop = G.ballActive && info.ballProgress >= 1 ? clamp(1 - (G.frame - G.ballFrame - G.ballDur) / 10, 0, 1) : 0;
            mitt.position.set(S.mitt.x, S.mitt.y, 0.3); mitt.scale.setScalar(1 + pop * 0.12);
            mitt.rotation.set(0.1, 0, Math.sin(G.frame * 0.05) * 0.04);
        }
        renderer.render(scene, camera);
    };

    return api;
})();
