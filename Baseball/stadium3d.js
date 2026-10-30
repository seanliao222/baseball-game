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
    const ZHW = 55 / K, ZHH = 55 / K;   // half-size of the (game) strike zone on the plate plane, metres
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
    let renderer, scene, camera, zoneCam, pitchZoneCam, canvas3d, maxAniso = 4;
    let cw = 800, ch = 600;                       // canvas px (CSS px; DPR handled by setPixelRatio)
    let rect = { x: 0, y: 0, w: 800, h: 600 };    // game rect inside the canvas

    const sun = new THREE.DirectionalLight(0xfff2dc, 1.15);
    let scoreboardCtx = null, scoreboardTex = null, scoreboardKey = '';
    // stadium flags show the HOME team's flag (team colours + cap logo); neutral until a game starts
    let flagCv = null, flagTexRef = null, flagKey = '';
    function setFlagTeam(team) {
        const key = team ? team.abbr : '-'; if (key === flagKey || !flagCv) return; flagKey = key;
        const g = flagCv.getContext('2d'), w = 256, h = 140;
        const c1 = team ? team.c1 : '#1d3b78', c2 = team && team.c2 && team.c2.toLowerCase() !== '#ffffff' ? team.c2 : (team ? '#ffffff' : '#e8eef9');
        const base = team && lum(c1) < 0.06 ? c2 : c1;                       // very dark base colour -> use the second colour as the field
        const stripe = base === c1 ? c2 : '#ffffff';
        g.fillStyle = base; g.fillRect(0, 0, w, h);
        g.fillStyle = stripe; g.fillRect(0, 0, w, 16); g.fillRect(0, h - 16, w, 16);
        g.fillStyle = 'rgba(0,0,0,0.12)'; for (let x = 0; x < w; x += 32) g.fillRect(x, 16, 16, h - 32);
        const fg = lum(base) > 0.55 ? '#111111' : '#ffffff', logo = team ? (team.hatLogo || team.abbr) : '⚾';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fg;
        g.font = 'bold ' + (logo.length > 1 ? 66 : 84) + 'px "PingFang TC","Microsoft JhengHei",Arial'; g.fillText(logo, w / 2, h / 2 - 6);
        if (team) { g.font = 'bold 22px "PingFang TC","Microsoft JhengHei",Arial'; g.fillText(team.abbr, w / 2, h - 30); }
        if (flagTexRef) flagTexRef.needsUpdate = true;
    }
    let flashPts = null, vidRT = null, vidCam = null, videoPlane = null, vidTick = 0;
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
    const std = (color, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85, metalness: 0, envMapIntensity: 0.55 }, o));

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
        const skyCanvas = buildSkyTexture();
        scene.background = texOf(skyCanvas);
        try {
            const eq = new THREE.CanvasTexture(skyCanvas); eq.mapping = THREE.EquirectangularReflectionMapping;
            const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromEquirectangular(eq).texture; pm.dispose();
        } catch (e) { console.warn('env map skipped', e); }
        scene.fog = new THREE.FogExp2(0xb9d6ee, 0.0017);

        scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x6f7f4c, 0.4));
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
        ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, -70); ground.receiveShadow = true; ground.material.envMapIntensity = 0.08;
        scene.add(ground);

        const skirt = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ color: 0x1f5a28, roughness: 1 }));
        skirt.rotation.x = -Math.PI / 2; skirt.position.set(0, -0.04, 0); scene.add(skirt);
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ map: texOf(buildPlateDirtTexture()), transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        plate.rotation.x = -Math.PI / 2; plate.position.set(0, 0.004, 0); plate.receiveShadow = true; plate.material.envMapIntensity = 0.08;
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
        mound.position.set(0, 0.13, MOUND_Z); mound.receiveShadow = true; mound.material.envMapIntensity = 0.08; mound.castShadow = false; scene.add(mound);
        const rubber = new THREE.Mesh(new THREE.BoxGeometry(0.61, 0.04, 0.15), chalk);
        rubber.position.set(0, 0.28, MOUND_Z); scene.add(rubber);

        // outfield wall
        const wallTex = texOf(buildWallTexture(), { wrap: true });
        const wallRows = [], N = 360;
        for (let i = 0; i <= N; i++) {
            const th = lerp(-Math.PI, Math.PI, i / N), r = bowlR(th);
            const x = r * Math.sin(th), z = -r * Math.cos(th);
            wallRows.push([[x, 0, z], [x, 3.0, z]]);
        }
        const wall = stripMesh(wallRows.filter((r, i) => Math.abs(lerp(-Math.PI, Math.PI, i / N)) < Math.PI * 0.64), 1 / 64, 1 / 3.0, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7, side: THREE.DoubleSide, emissive: 0x112211, emissiveIntensity: 0.15 }));
        scene.add(wall);

        // batter's eye (dark green panel behind CF)
        const eye = new THREE.Mesh(new THREE.PlaneGeometry(34, 7), new THREE.MeshStandardMaterial({ color: 0x0b2316, roughness: 1 }));
        eye.position.set(0, 6.5, -wallR(0) - 1.0); scene.add(eye);

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
            const rows = [], n = 360;
            for (let i = 0; i <= n; i++) {
                const th = lerp(th0, th1, i / n), s = Math.sin(th), c = -Math.cos(th);
                const ri = fnIn(th), ro = fnOut(th);
                rows.push([[ri * s, yIn, ri * c], [ro * s, yOut, ro * c]]);
            }
            const m = stripMesh(rows, su, sv, mat); scene.add(m); return m;
        };
        const T0 = -Math.PI, T1 = Math.PI;
        arc(th => bowlR(th) + 3, 3.2, th => bowlR(th) + 26, 10.5, T0, T1, mkCrowdMat(crowdA), 1 / 40, 1 / 20);
        arc(th => bowlR(th) + 26, 10.5, th => bowlR(th) + 29, 10.5, T0, T1, new THREE.MeshBasicMaterial({ color: 0x8a93a6, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 29, 10.5, th => bowlR(th) + 31, 15, T0, T1, new THREE.MeshBasicMaterial({ color: 0x9aa3b6, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 31, 15, th => bowlR(th) + 58, 28, T0, T1, mkCrowdMat(crowdB), 1 / 40, 1 / 26);
        arc(th => bowlR(th) + 58, 28, th => bowlR(th) + 58, 32, T0, T1, new THREE.MeshBasicMaterial({ color: 0x6c7488, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 58, 32, th => bowlR(th) + 24, 32, T0, T1, new THREE.MeshBasicMaterial({ color: 0x5a6174, side: THREE.DoubleSide }), 1, 1);
        arc(th => bowlR(th) + 3, 3.2, th => bowlR(th) + 3, 0, T0, T1, new THREE.MeshBasicMaterial({ color: 0x7b869c, side: THREE.DoubleSide }), 1, 1);

        // close-in ad boards + front-row crowd behind home plate: this is what the long-lens pitcher camera sees
        {
            const adT = texOf(buildWallTexture(), { wrap: true, rx: 1.3, ry: 1 });
            const ad = new THREE.Mesh(new THREE.PlaneGeometry(84, 3.4), new THREE.MeshStandardMaterial({ map: adT, roughness: 0.7, emissive: 0x161616, emissiveIntensity: 0.6 }));
            ad.position.set(0, 1.7, 30); ad.rotation.y = Math.PI; scene.add(ad);
            const cT = texOf(buildCrowdTexture(17, ['#c8102e', '#0b3d91', '#e0e0e0']), { wrap: true, rx: 4, ry: 0.9 });
            const crowd = new THREE.Mesh(new THREE.PlaneGeometry(84, 9), new THREE.MeshBasicMaterial({ map: cT, color: 0xd4d8e6 }));
            crowd.position.set(0, 7.9, 31.5); crowd.rotation.set(-0.25, Math.PI, 0); scene.add(crowd);
            const rail = new THREE.Mesh(new THREE.BoxGeometry(84, 0.35, 0.5), new THREE.MeshStandardMaterial({ color: 0x16203a }));
            rail.position.set(0, 3.5, 30.1); scene.add(rail);
        }

        // scoreboard
        const sb = canvasOf(1024, 400); scoreboardCtx = sb.getContext('2d'); scoreboardTex = texOf(sb);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(36, 14), new THREE.MeshBasicMaterial({ map: scoreboardTex }));
        board.position.set(0, 18.4, -bowlR(0) - 14); scene.add(board);
        drawScoreboard(null);
        // live "pitcher's-eye view of the batter" shown on the video board (rendered to a texture every other frame)
        vidRT = new THREE.WebGLRenderTarget(384, 288, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
        vidCam = new THREE.PerspectiveCamera(6.8, 384 / 288, 0.5, 90);
        videoPlane = new THREE.Mesh(new THREE.PlaneGeometry(14.5, 10.9), new THREE.MeshBasicMaterial({ map: vidRT.texture }));
        videoPlane.position.set(board.position.x + 10.17, board.position.y + 1.5, board.position.z + 0.06); scene.add(videoPlane);

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
        const fc = canvasOf(256, 140), flagTex = texOf(fc);
        flagCv = fc; flagTexRef = flagTex; setFlagTeam(null);
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
        const key = G ? [G.inning, G.half, G.score[0], G.score[1], G.balls, G.strikes, G.outs, info.awayAbbr, info.homeAbbr, info.batter.name, info.batter.avg].join('|') : 'idle';
        if (key === scoreboardKey) return;
        scoreboardKey = key;
        const g = scoreboardCtx, W_ = 1024, H_ = 400;
        g.fillStyle = '#050608'; g.fillRect(0, 0, W_, H_);
        g.strokeStyle = '#2a3042'; g.lineWidth = 8; g.strokeRect(4, 4, W_ - 8, H_ - 8);
        g.textBaseline = 'middle';
        // right panel frame (the live "pitcher-view" video plane sits over x 596..1008, y 6..314)
        g.fillStyle = '#0b0e16'; g.fillRect(590, 0, 434, H_);
        g.strokeStyle = '#3a4560'; g.lineWidth = 4; g.strokeRect(594, 4, 416, 312);
        if (!G) { g.fillStyle = '#ffcc33'; g.font = 'bold 100px Arial'; g.textAlign = 'center'; g.fillText('PLAY BALL', 300, H_ / 2); scoreboardTex.needsUpdate = true; return; }
        // caption under the video: batter name + average
        g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.font = 'bold 40px "PingFang TC","Microsoft JhengHei",Arial'; g.fillText(info.batter.name, 612, 346);
        g.fillStyle = '#9fb0cc'; g.font = 'bold 28px Arial'; g.fillText('AVG ' + info.batter.avg + '   HR ' + info.batter.hr, 612, 380);
        g.fillStyle = '#ff3b30'; g.beginPath(); g.arc(990, 346, 9, 0, Math.PI * 2); g.fill(); g.fillStyle = '#ffb3ae'; g.font = 'bold 20px Arial'; g.textAlign = 'right'; g.fillText('LIVE', 972, 347);
        // score rows
        const row = (y, abbr, score, col, act) => {
            g.fillStyle = col; g.fillRect(34, y - 40, 14, 80);
            g.fillStyle = act ? '#ffffff' : '#9aa3b8'; g.textAlign = 'left'; g.font = 'bold 76px "PingFang TC","Microsoft JhengHei",Arial'; g.fillText(abbr, 66, y);
            g.fillStyle = '#ffcc33'; g.textAlign = 'right'; g.font = 'bold 110px Arial'; g.fillText(String(score), 370, y);
        };
        row(100, info.awayAbbr, G.score[0], info.awayCol, G.half === 0);
        row(240, info.homeAbbr, G.score[1], info.homeCol, G.half === 1);
        g.fillStyle = '#33ff88'; g.font = 'bold 78px Arial'; g.textAlign = 'center';
        g.fillText((G.half === 0 ? '▲ ' : '▼ ') + G.inning, 480, 100);
        const dots = (label, y, n, max, col) => {
            g.fillStyle = '#aab'; g.font = 'bold 40px Arial'; g.textAlign = 'left'; g.fillText(label, 412, y);
            for (let i = 0; i < max; i++) { g.beginPath(); g.arc(462 + i * 40, y, 14, 0, Math.PI * 2); g.fillStyle = i < n ? col : '#1c2130'; g.fill(); }
        };
        dots('B', 190, G.balls, 3, '#35e07a'); dots('S', 245, G.strikes, 2, '#ffd23a'); dots('O', 300, G.outs, 2, '#ff4d3a');
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
        geo.sleeve = limbGeo([[0.062, 0], [0.068, -0.06], [0.068, -0.12], [0.064, -0.185]], 14);
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

    // grayscale bump texture: fine weave + soft wrinkle streaks (cached per kind, shared between people)
    const bumpCache = {};
    function fabricBump(w, h, kind) {
        if (bumpCache[kind]) return bumpCache[kind];
        const c = canvasOf(w, h), g = c.getContext('2d'), R = seeded(hash(kind));
        g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
        const n = kind === 'jersey' ? 7 : 4;
        for (let i = 0; i < n; i++) {   // wrinkles: soft light/dark pairs of streaks
            const x = R() * w, y = R() * h, len = (kind === 'pants' ? 0.35 : 0.22) * h, ang = kind === 'pants' ? Math.PI / 2 + (R() - 0.5) * 0.6 : (R() - 0.5) * 1.2;
            const gr = g.createLinearGradient(x, y, x + Math.cos(ang + Math.PI / 2) * 6, y + Math.sin(ang + Math.PI / 2) * 6);
            gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.35, 'rgba(0,0,0,0.22)'); gr.addColorStop(0.65, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
            g.strokeStyle = gr; g.lineWidth = 9; g.lineCap = 'round'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); g.stroke();
        }
        const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; bumpCache[kind] = t; return t;
    }

    // soft contact shadow disc: grounds every player
    let aoTex = null;
    function contactAO() {
        if (!aoTex) { const c = canvasOf(64, 64), g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); aoTex = new THREE.CanvasTexture(c); }
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.8), new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        m.rotation.x = -Math.PI / 2; m.position.y = 0.016; m.renderOrder = 1; return m;
    }

    function makePerson(kind) {
        const m = {
            jersey: std(0xffffff), accent: std(0xcccccc), pants: std(0xeeeeee), sock: std(0xcccccc), skin: std(0xe0ac84, { roughness: 0.7 }),
            cap: std(0x222222, { roughness: 0.6 }), shoe: std(0x15151a, { roughness: 0.5 }), glove: std(0x6b3b1a, { roughness: 0.45, envMapIntensity: 0.9 }),
            dark: std(0x101014), gear: std(0x1a2238, { roughness: 0.6 }), bat: std(0xffffff, { roughness: 0.32, envMapIntensity: 1.0 }),
            hips: std(0xeeeeee), hand: std(0xe0ac84, { roughness: 0.7 }), forearm: std(0xe0ac84, { roughness: 0.65 }), sleeve: std(0xffffff), band: std(0xffffff, { roughness: 0.6 }), hair: std(0x17120e, { roughness: 0.9 }), sole: std(0xe6e6ea, { roughness: 0.6 })
        };
        const jerseyC = canvasOf(256, 256), jerseyT = new THREE.CanvasTexture(jerseyC);
        jerseyT.wrapS = THREE.RepeatWrapping; jerseyT.offset.x = 0.5; jerseyT.anisotropy = maxAniso; m.jersey.map = jerseyT;
        const pantsC = canvasOf(64, 128), pantsT = new THREE.CanvasTexture(pantsC); pantsT.anisotropy = maxAniso; m.pants.map = pantsT;
        m.jersey.bumpMap = fabricBump(256, 256, 'jersey'); m.jersey.bumpMap.wrapS = THREE.RepeatWrapping; m.jersey.bumpMap.offset.x = 0.5; m.jersey.bumpScale = 0.6;

        const root = new THREE.Group(); root.rotation.order = 'YXZ'; root.add(contactAO());
        const part = (g, mat, parent, shadow = true) => { const me = new THREE.Mesh(g, mat); me.castShadow = shadow; parent.add(me); return me; };
        const blob = (mat, parent, sx, sy, sz, x = 0, y = 0, z = 0) => { const me = new THREE.Mesh(geo.ball, mat); me.scale.set(sx, sy, sz); me.position.set(x, y, z); me.castShadow = true; parent.add(me); return me; };
        const hips = new THREE.Group(); hips.position.y = HIP_Y; root.add(hips);
        blob(m.hips, hips, 0.19, 0.14, 0.14, 0, -0.04, 0);
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

        const guards = [];
        const mkArm = side => {
            const s = side === 'L' ? 1 : -1;
            const sh = new THREE.Group(); sh.position.set(0.235 * s, 0.5, 0); torso.add(sh);
            part(geo.upperArm, m.forearm, sh).scale.set(1.15, 1, 1.15);                  // bare upper arm
            part(geo.sleeve, m.sleeve, sh).scale.set(1.2, 1, 1.2);                          // short sleeve
            const cuff = part(new THREE.TorusGeometry(0.078, 0.01, 8, 18), m.accent, sh, false); cuff.rotation.x = Math.PI / 2; cuff.position.y = -0.18;
            blob(m.sleeve, sh, 0.085, 0.08, 0.085, 0, 0.0, 0);                              // deltoid
            const el = new THREE.Group(); el.position.y = -0.29; sh.add(el);
            const guard = blob(m.dark, el, 0.062, 0.07, 0.062, 0, 0.0, 0); guard.visible = false; guards.push(guard);
            part(geo.foreArm, m.hand === undefined ? m.skin : m.forearm, el).scale.set(1.2, 1, 1.2);
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
        const gm = part(geo.ball, m.glove, gloveG); gm.scale.set(0.115, 0.14, 0.075); gm.position.set(0, -0.035, 0.05);
        const gm2 = part(geo.ball, m.glove, gloveG); gm2.scale.set(0.075, 0.12, 0.055); gm2.position.set(0.035, 0.05, 0.05);
        const gm3 = part(geo.ball, m.glove, gloveG); gm3.scale.set(0.05, 0.09, 0.045); gm3.position.set(-0.04, 0.045, 0.05);
        gloveG.visible = false;
        const holder = new THREE.Group(); torso.add(holder);
        const batC = canvasOf(64, 256), bg = batC.getContext('2d'), br = seeded(5);
        const wood = bg.createLinearGradient(0, 0, 64, 0); wood.addColorStop(0, '#b8844a'); wood.addColorStop(0.5, '#d4a468'); wood.addColorStop(1, '#b17b43'); bg.fillStyle = wood; bg.fillRect(0, 0, 64, 256);
        for (let i = 0; i < 90; i++) { bg.strokeStyle = 'rgba(90,50,15,' + (0.08 + br() * 0.14) + ')'; bg.lineWidth = 0.6 + br(); bg.beginPath(); const x = br() * 64; bg.moveTo(x, 0); bg.bezierCurveTo(x + 5 * (br() - 0.5), 80, x - 5 * (br() - 0.5), 170, x + 4 * (br() - 0.5), 256); bg.stroke(); }
        bg.fillStyle = '#16161a'; bg.fillRect(0, 196, 64, 60);                      // tape (handle end = bottom of the canvas)
        for (let y = 198; y < 256; y += 5) { bg.fillStyle = 'rgba(255,255,255,0.07)'; bg.fillRect(0, y, 64, 1.5); }
        bg.fillStyle = '#6b1d1d'; bg.fillRect(0, 150, 64, 8);                        // brand band
        m.bat.map = new THREE.CanvasTexture(batC);
        const bat = part(geo.bat, m.bat, holder); holder.visible = false;
        const chest = part(new THREE.BoxGeometry(0.44, 0.5, 0.26), m.gear, torso); chest.position.set(0, 0.3, 0.02); chest.visible = false;
        const shinGuardL = part(new THREE.BoxGeometry(0.1, 0.34, 0.09), m.gear, legL.kn, false); shinGuardL.position.set(0, -0.22, 0.07); shinGuardL.visible = false;
        const shinGuardR = shinGuardL.clone(); legR.kn.add(shinGuardR);
        // jersey number plate on the back
        const numC = canvasOf(128, 128), numT = new THREE.CanvasTexture(numC);
        const num = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ map: numT, transparent: true }));
        num.position.set(0, 0.33, -0.178); num.rotation.y = Math.PI; torso.add(num); num.visible = false;

        const p = { kind, root, hips, torso, head, armL, armR, guards, legL, legR, mats: m, jerseyC, jerseyT, pantsC, pantsT, capG, flap, mask, logoC, logoT, numC, numT, num, gloveG, holder, bat, chest, shinGuardL, shinGuardR, brim, belt, fade: 1, teamKey: '' };
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

    // team-specific uniform looks; anything not listed falls back to the generic colour-based style
    const UNI = {
        Dodgers: { noPiping: true, trim: '#005A9C', front: h => h ? 'Dodgers' : 'Los Angeles', frontCol: '#005A9C', sock: '#005A9C', accent: '#005A9C', frontSize: 40 },
        // 統一獅 2026: orange jersey with black side panels, white piping, UNILIONS across the chest (road: grey-white with the same trim)
        Lions: { noPiping: true, lions: true, trim: '#111111', front: () => '', frontCol: '#111111', sock: '#111111', accent: '#111111', jerseyOverride: h => h ? '#FF6A13' : '#E6E7EA' },
        // 中華隊 2026: charcoal jersey with fine vertical stripes, white italic "Taiwan" script (blue outline), white pants, black cap
        'Chinese Taipei': { noPiping: true, taiwan: true, trim: '#9fb4c8', front: () => '', frontCol: '#ffffff', sock: '#ffffff', accent: '#9fb4c8', cap: '#111111', whitePants: true, jerseyOverride: () => '#2b2d31' },
        Yankees: { noPiping: true, pinstripe: '#0c2340', trim: '#0c2340', front: h => h ? '' : 'NEW YORK', frontCol: '#0c2340', sock: '#0c2340', accent: '#0c2340', frontSize: 34 }
    };
    function dressTeam(p, team, isHome, opts = {}) {
        const key = [team.abbr, isHome, opts.helmet, opts.number, p.skinKey].join('|');
        if (p.teamKey === key) return; p.teamKey = key;
        const jl = lum(team.jersey || '#ffffff');
        const U0 = UNI[team.name] || null;
        const jersey = U0 && U0.jerseyOverride ? U0.jerseyOverride(isHome) : (isHome ? (team.jersey || '#ffffff') : (jl > 0.8 ? '#c4c9d2' : (team.jersey || '#c4c9d2')));
        const c2 = team.c2 && team.c2.toLowerCase() !== '#ffffff' ? team.c2 : team.c1;
        p.mats.jersey.color.set(0xffffff); p.mats.pants.color.set(0xffffff); p.mats.sleeve.color.set(jersey); p.mats.hips.color.set(isHome ? '#f3f3f6' : '#c9ced8');
        p.mats.accent.color.set(isHome ? (jl > 0.6 ? '#f1f1f4' : c2) : c2);
        p.mats.band.color.set(c2);
        const U = UNI[team.name] || null, pantsHex = (isHome || (U && U.whitePants)) ? '#f3f3f6' : '#c9ced8';
        if (U) { p.mats.accent.color.set(U.accent); p.mats.band.color.set(U.accent); }
        // jersey texture: front lettering, side piping, subtle fabric noise
        {
            const g = p.jerseyC.getContext('2d'), w = 256, h = 256, pipe = U ? U.trim : (lum(c2) > 0.85 ? team.c1 : c2);
            g.fillStyle = jersey; g.fillRect(0, 0, w, h);
            for (let i = 0; i < 700; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.035)'; g.fillRect(Math.random() * w, Math.random() * h, 3, 2); }
            if (!(U && U.noPiping)) { g.fillStyle = pipe; [0.25, 0.75].forEach(f => g.fillRect(f * w - 2.5, 0, 5, h)); }
            if (U && U.lions) {
                // black side panels (centred on u=0.25 / 0.75), black shoulder yoke, white piping along the panel edges
                g.fillStyle = '#111111'; [0.25, 0.75].forEach(f => { g.fillRect(f * w - 18, 44, 36, h - 44); });
                g.fillRect(0, 0, w, 20);
                g.fillStyle = '#ffffff'; [0.25, 0.75].forEach(f => { g.fillRect(f * w - 21, 44, 2, h - 44); g.fillRect(f * w + 19, 44, 2, h - 44); });
                g.fillRect(0, 20, w, 2);
                const word = 'UNILIONS'; g.font = 'italic 900 19px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
                g.lineWidth = 4; g.strokeStyle = isHome ? '#ffffff' : '#FF6A13'; g.lineJoin = 'round'; g.strokeText(word, w / 2, 104); g.fillStyle = '#111111'; g.fillText(word, w / 2, 104);
            }
            if (U && U.taiwan) {
                g.fillStyle = 'rgba(255,255,255,0.10)'; for (let x = 3; x < w; x += 5) g.fillRect(x, 0, 1, h);       // fine vertical stripes
                const word = 'Taiwan'; g.font = 'italic 900 40px "Brush Script MT","Segoe Script",cursive'; g.textAlign = 'center'; g.textBaseline = 'middle';
                g.lineWidth = 7; g.lineJoin = 'round'; g.strokeStyle = '#1d4fa8'; g.strokeText(word, w / 2, 110);
                g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.strokeText(word, w / 2, 110);
                g.fillStyle = '#ffffff'; g.fillText(word, w / 2, 110);
            }
            if (U && U.pinstripe && isHome) { g.fillStyle = U.pinstripe; g.globalAlpha = 0.85; for (let x = 4; x < w; x += 9) g.fillRect(x, 0, 1.6, h); g.globalAlpha = 1; }   // home pinstripes
            g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, h - 10, w, 10);
            const front = U ? U.front(isHome) : (team.abbr || ''), lt = front.length;
            if (front) {
                g.font = (U ? 'italic bold ' + (U.frontSize || 40) : 'bold ' + (lt <= 2 ? 58 : lt === 3 ? 46 : 36)) + 'px "PingFang TC","Microsoft JhengHei",Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
                if (!U) { g.lineWidth = 6; g.strokeStyle = pipe; g.lineJoin = 'round'; g.strokeText(front, w / 2, 112); }
                g.fillStyle = U ? U.frontCol : (lum(jersey) > 0.6 ? team.c1 : '#ffffff'); g.fillText(front, w / 2, 112);
            }
            g.strokeStyle = pipe; g.lineWidth = 4; g.beginPath(); g.moveTo(w / 2 - 22, 12); g.lineTo(w / 2, 36); g.lineTo(w / 2 + 22, 12); g.stroke();   // collar V
            p.jerseyT.needsUpdate = true;
            const q = p.pantsC.getContext('2d'); q.fillStyle = pantsHex; q.fillRect(0, 0, 64, 128);
            if (U && U.lions) { q.fillStyle = '#FF6A13'; [16, 48].forEach(x => q.fillRect(x - 1.5, 0, 3, 128)); }
            else if (U && U.pinstripe && isHome) { q.fillStyle = U.pinstripe; q.globalAlpha = 0.85; for (let x = 3; x < 64; x += 6) q.fillRect(x, 0, 1.2, 128); q.globalAlpha = 1; }
            else if (!(U && U.noPiping)) { q.fillStyle = pipe; [16, 48].forEach(x => q.fillRect(x - 2, 0, 4, 128)); }
            for (let i = 0; i < 200; i++) { q.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)'; q.fillRect(Math.random() * 64, Math.random() * 128, 2, 3); }
            p.pantsT.needsUpdate = true;
        }
        p.gloves = !!opts.helmet; p.mats.hand.color.set(p.gloves ? 0xf4f4f6 : (p.skinColor || 0xe0ac84)); p.mats.forearm.color.set(p.skinColor || 0xe0ac84);
        p.mats.sock.color.set(U ? U.sock : c2);
        p.mats.cap.color.set(U && U.cap ? U.cap : team.c1);
        p.flap.visible = !!opts.helmet;
        p.mats.cap.roughness = opts.helmet ? 0.18 : 0.75; p.mats.cap.metalness = opts.helmet ? 0.25 : 0; p.mats.cap.envMapIntensity = opts.helmet ? 1.6 : 0.5;
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
        const k = hash(name || '') % tones.length; p.skinKey = k; p.skinColor = tones[k]; p.mats.skin.color.set(tones[k]); p.mats.forearm.color.set(tones[k]); p.mats.hand.color.set(p.gloves ? 0xf4f4f6 : tones[k]);
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
    let ball, hitBall, ballShadow, trail = [], flashSprite, glowTex, mitt, mittT = 0, ballGlow;
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

        for (let i = 0; i < 5; i++) { const r = makePerson('runner'); r.root.visible = false; r.hold = i; actors.extras.push(r); }

        // ball
        const bm = new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.55, emissive: 0x333330, emissiveIntensity: 0.55 });
        ball = new THREE.Mesh(geo.ball, bm); ball.scale.setScalar(0.045); ball.castShadow = true; ball.visible = false; scene.add(ball);
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
        ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.0, fog: false }));
        ballGlow.visible = false; scene.add(ballGlow);
        flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
        flashSprite.scale.set(1.4, 1.4, 1); scene.add(flashSprite);
    }

    // ───────────────────────── camera rig ─────────────────────────
    const camS = { pos: new THREE.Vector3(0, 1.6, 7.4), look: new THREE.Vector3(0, ZONE_Y, 0), fov: 25, shift: 100 };
    // Pitcher camera: long lens from far behind the mound (so the pitcher, catcher, umpire and batter all read at TV-like sizes)
    const PITCH_CAM = { pos: new THREE.Vector3(-6.0, 4.6, -100), look: new THREE.Vector3(0, ZONE_Y, 0), shift: 55 };
    PITCH_CAM.fov = 2 * Math.atan(GH / (2 * PITCH_CAM.pos.distanceTo(PITCH_CAM.look) * (48 / ZHW))) * 180 / Math.PI;
    const BAT_CAM = { pos: new THREE.Vector3(0, 1.6, 7.4), look: new THREE.Vector3(0, ZONE_Y, 0), shift: 100 };
    BAT_CAM.fov = 2 * Math.atan(GH / (2 * BAT_CAM.pos.distanceTo(BAT_CAM.look) * K)) * 180 / Math.PI;

    function applyCamera(cam, st) {
        cam.position.copy(st.pos); cam.fov = st.fov; cam.aspect = rect.w / rect.h;
        const sh = st.shift * rect.h / GH;
        cam.setViewOffset(rect.w, rect.h, -rect.x, -rect.y - sh, cw, ch);
        cam.lookAt(st.look); cam.updateMatrixWorld(true);
    }
    // The 2D aiming UI works in game px. `box` says where the strike zone sits on screen for the current aim camera:
    // batter camera (behind the plate, looking out) or pitcher camera (behind the mound, looking in; screen-right = world -x).
    const BOX = { bat: { cx: SZX, cy: SZY, hw: 55, hh: 55 }, pitch: { cx: SZX, cy: SZY, hw: 48, hh: 48 } };
    let aimMode = 'bat';
    function pxToPlane(sx, sy, out) {
        const b = BOX[aimMode], u = (sx - b.cx) / b.hw, v = (sy - b.cy) / b.hh;
        return (out || new THREE.Vector3()).set((aimMode === 'pitch' ? -1 : 1) * u * ZHW, ZONE_Y - v * ZHH, 0);
    }
    function planeToPx(x, y) {
        const b = BOX[aimMode], u = (aimMode === 'pitch' ? -1 : 1) * x / ZHW, v = (ZONE_Y - y) / ZHH;
        return { x: b.cx + u * b.hw, y: b.cy + v * b.hh };
    }

    function resize(winW, winH, gameRect) {
        if (!renderer) return;
        cw = winW; ch = winH; rect = { x: gameRect.x, y: gameRect.y, w: gameRect.w, h: gameRect.h };
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(cw, ch, false);
        canvas3d.style.width = cw + 'px'; canvas3d.style.height = ch + 'px';
        applyCamera(zoneCam, { pos: BAT_CAM.pos, look: BAT_CAM.look, fov: BAT_CAM.fov, shift: BAT_CAM.shift });
        // where the zone lands on screen for the pitcher camera (computed from a frozen copy of that camera)
        applyCamera(pitchZoneCam, { pos: PITCH_CAM.pos, look: PITCH_CAM.look, fov: PITCH_CAM.fov, shift: PITCH_CAM.shift });
        const pc = [[-ZHW, ZONE_Y - ZHH], [ZHW, ZONE_Y + ZHH]].map(([x, y]) => { _pv.set(x, y, 0).project(pitchZoneCam); return { x: ((_pv.x * 0.5 + 0.5) * cw - rect.x) / rect.w * GW, y: ((-_pv.y * 0.5 + 0.5) * ch - rect.y) / rect.h * GH }; });
        BOX.pitch = { cx: (pc[0].x + pc[1].x) / 2, cy: (pc[0].y + pc[1].y) / 2, hw: Math.abs(pc[1].x - pc[0].x) / 2, hh: Math.abs(pc[1].y - pc[0].y) / 2 };
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

    // arm slots (right-handed frame; lefties are mirrored): 上壓 overhand, 四分之三, 側投, 低肩側投 / 下勾
    const ARM_SLOTS = {
        over:  { cock: [-0.42, 1.55, -0.42], rel: [-0.25, 2.1, 0.55],  fol: [0.2, 0.95, 0.65],  lean: 0 },
        three: { cock: [-0.62, 1.4, -0.4],   rel: [-0.5, 1.8, 0.55],   fol: [0.1, 0.9, 0.65],   lean: 0.12 },
        side:  { cock: [-0.82, 1.15, -0.3],  rel: [-0.85, 1.35, 0.5],  fol: [0.0, 0.85, 0.7],   lean: 0.3 },
        under: { cock: [-0.75, 0.75, -0.2],  rel: [-0.8, 0.85, 0.55],  fol: [0.05, 0.9, 0.75],  lean: 0.5 }
    };
    function armSlotOf(pt) {
        if (!pt) return 'over';
        if (pt.slot) return pt.slot;
        let h = 11; const n = String(pt.name || ''); for (let i = 0; i < n.length; i++) h = (h * 33 + n.charCodeAt(i)) >>> 0;
        const r = (h % 100) / 100;
        return r < 0.38 ? 'over' : r < 0.82 ? 'three' : r < 0.95 ? 'side' : 'under';
    }
    function pitcherHands(p, hh, t) {
        // returns [rightHandTarget, leftHandTarget] in pitcher-local coords (forward = +z)
        const lerpV = (a, b, t_) => [lerp(a[0], b[0], t_), lerp(a[1], b[1], t_), lerp(a[2], b[2], t_)];
        const setR = [-0.03, 1.28, 0.3], setL = [0.03, 1.3, 0.3];
        const high = [[-0.05, 1.95, 0.2], [0.05, 1.9, 0.2]];
        const sl = ARM_SLOTS[S.slot] || ARM_SLOTS.over;      // arm slot: how high the throwing hand cocks / releases
        const cock = [sl.cock, [0.32, 1.55, 0.55]];
        const rel = [sl.rel, [0.3, 1.45, 0.5]];
        const fol = [sl.fol, [0.15, 1.35, 0.3]];
        if (hh <= 1) return [lerpV(setR, high[0], hh), lerpV(setL, high[1], hh)];
        if (hh <= 2) return [lerpV(high[0], cock[0], hh - 1), lerpV(high[1], cock[1], hh - 1)];
        if (hh <= 3) return [lerpV(cock[0], rel[0], hh - 2), lerpV(cock[1], rel[1], hh - 2)];
        return [lerpV(rel[0], fol[0], clamp(hh - 3, 0, 1)), lerpV(rel[1], fol[1], clamp(hh - 3, 0, 1))];
    }

    // mirror a pose left <-> right (for left-handed pitchers)
    const _SWAP = [['hipL', 'hipR'], ['kneeL', 'kneeR'], ['spreadL', 'spreadR'], ['armL', 'armR'], ['elbL', 'elbR'], ['absL', 'absR']];
    function mirrorPose(P) {
        const o = Object.assign({}, P);
        _SWAP.forEach(([a, b]) => { const va = P[a], vb = P[b]; if (vb !== undefined) o[a] = vb; else delete o[a]; if (va !== undefined) o[b] = va; else delete o[b]; });
        ['torsoY', 'hipsY', 'torsoZ', 'hipsZ', 'headY'].forEach(k => { if (o[k] !== undefined) o[k] = -o[k]; });
        return o;
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
        const lefty = info.pitcher && info.pitcher.throws === 'L';
        S.slot = armSlotOf(info.pitcher); const sl = ARM_SLOTS[S.slot];
        REL.x = (lefty ? -1 : 1) * sl.rel[0]; REL.y = sl.rel[1] - 0.18;      // release point is on the throwing-arm side, at the arm slot's height
        if (f >= 0 && f < 40) P = Object.assign({}, P, { torsoZ: (P.torsoZ || 0) + sl.lean * Math.sin(clamp(f / 14, 0, 1) * Math.PI / 2) * (f < 28 ? 1 : 1 - (f - 28) / 12) });      // lower slot leans the trunk away
        p.root.position.z = MOUND_Z + 0.1 + rootZ;
        if (lefty) P = mirrorPose(P);
        applyPose(p, P);
        // glove on the non-throwing hand
        { const tgtHand = lefty ? p.armR.hand : p.armL.hand; if (p.gloveG.parent !== tgtHand) { tgtHand.add(p.gloveG); p.gloveG.scale.x = lefty ? -1 : 1; } }
        p.root.updateMatrixWorld(true);
        const [hr, hl] = pitcherHands(p, hh, 0);
        const mx = lefty ? -1 : 1;
        p.root.localToWorld(v1.set(hr[0] * mx, hr[1], hr[2])); p.root.localToWorld(v2.set(hl[0] * mx, hl[1], hl[2]));
        ikArm(lefty ? p.armL : p.armR, v1, _hintDown.set(-0.4 * mx, -1, -0.2));       // throwing hand
        ikArm(lefty ? p.armR : p.armL, v2, _hintDown.set(0.5 * mx, -1, 0));            // glove hand
        _hintDown.set(0, -1, 0);
        p.handWorld = v1.clone();
    }

    function updateCatcher(G, info, dt) {
        const p = actors.catcher;
        // mitt target: aim spot while a human pitches, ball landing spot once thrown
        let tgt = _tmpW.set(0, ZONE_Y, 0);
        if (info.humanPitching && (G.phase === info.PH.AIM || G.phase === info.PH.POWER_GAUGE) && G.aimState !== 0)
            { const b = BOX[aimMode]; pxToPlane(b.cx + G.aimX * b.hw, b.cy + G.aimY * b.hh, tgt); }
        if (G.ballActive && G.frame - G.ballFrame < 200) {
            const t = clamp((G.frame - G.ballFrame) / G.ballDur, 0, 1);
            const bw = pitchWorld(G, 1, v3); tgt.copy(bw);
        }
        S.mitt.x = damp(S.mitt.x, tgt.x, 14, dt); S.mitt.y = damp(S.mitt.y, tgt.y, 14, dt);
        applyPose(p, P_CROUCH);
        p.root.rotation.y = Math.PI;                    // a steal throw turns him toward the base; square him back up to face the pitcher
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
    // pitch path: straight line release -> (pre-break) aim point, plus the break that arrives late, plus a float for loopy pitches
    const _pa = new THREE.Vector3(), _pl = new THREE.Vector3();
    function pitchWorld(G, t, out) {
        pxToPlane(G.ballAX, G.ballAY, _pa); pxToPlane(G.ballEX, G.ballEY, _pl);
        const f = Math.pow(t, G.ballLate || 1);
        out.copy(REL).lerp(_pa.set(_pa.x, _pa.y, 0), t);
        out.x += (_pl.x - _pa.x) * f; out.y += (_pl.y - _pa.y) * f; out.z = 0 + (REL.z * (1 - t));
        out.y += Math.sin(t * Math.PI) * ((G.ballHump || 0) * 0.55 + 0.04);     // curveballs float up before they fall
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
                const Rr = ZHW * (info.ballR || 0.147);                                 // radius at the plate: ~4.5 cm (a real ball is 3.7 cm) = the radius used to call strikes
                const toPlate = 1 - t;                                                  // 0 at the plate, 1 at release
                ball.scale.setScalar(Rr * (1 + (aimMode === 'pitch' ? 0.25 : 0.8) * toPlate));   // only a touch bigger far away so it stays visible
                const near = toPlate;
                ballGlow.visible = true; ballGlow.position.copy(ball.position); ballGlow.scale.setScalar(ZHW * (info.ballR || 0.147) * 2.5 * (1 + 0.6 * near)); ballGlow.material.opacity = 0.38; if (G.lastPitchCol) ballGlow.material.color.set(G.lastPitchCol);
                const pid = G.lastPitchId;
                if (pid === 0) ball.rotation.x -= 0.55 * df;                                   // 4-seam: backspin
                else if (pid === 4 || pid === 6) ball.rotation.x += 0.45 * df;                // curve / fork: topspin
                else if (pid === 2 || pid === 3 || pid === 7) { ball.rotation.y += 0.55 * df; ball.rotation.x -= 0.1 * df; }   // slider family: sidespin
                else if (pid === 5) ball.rotation.x -= 0.18 * df;                              // changeup: slow spin
                else { ball.rotation.x -= 0.4 * df; ball.rotation.z += 0.2 * df; }
                ball.visible = true;
                // trail
                for (let i = 0; i < trail.length; i++) {
                    const tt = t - (i + 1) * 0.035;
                    if (tt <= 0 || t >= 1) { trail[i].visible = false; continue; }
                    pitchWorld(G, tt, trail[i].position); trail[i].visible = true;
                    trail[i].scale.setScalar(ZHW * 0.147 * 0.85 * (1 - i * 0.07) * (1 + 0.6 * (1 - tt))); trail[i].material.opacity = 0.34 * (1 - i / trail.length); if (G.lastPitchCol) trail[i].material.color.set(G.lastPitchCol);
                }
                if (t >= 1) { for (const tr of trail) tr.visible = false; ballGlow.visible = false; }
            }
        }
        if (!show) { ball.visible = false; if (ballGlow) ballGlow.visible = false; if (!S.flight) for (const tr of trail) tr.visible = false; }
        // overlay catcher-mitt contact
        if (show && info.ballProgress >= 1) { ball.position.z = 0.22; }
    }

    // ── fielding range ───────────────────────────────────
    // how far (m) a fielder can be from a spot t frames after contact: a reaction delay, then a sprint
    const _fp = new THREE.Vector3();
    function fieldReach(kind, t, k) { return 1.6 + 0.24 * (k || 1) * Math.max(0, t - (kind === 'fly' ? 8 : kind === 'line' ? 10 : 12)); }      // k: the fielder's 守備 factor (a better glove covers more ground)
    // best chance any fielder has at a provisional batted ball c (t0 = 0): slack > 0 → someone gets there in time
    function catchSlack(c) {
        let best = -1e9, who = null;
        for (let t = 6; t <= c.dur + 1; t += 2) {
            flightPos(c, Math.min(t, c.dur), _fp);
            if (_fp.y > 2.8) continue;                          // above a fielder's glove
            for (const f of actors.fielders) { const s = fieldReach(c.kind, t, f.defF) - Math.hypot(f.cur.x - _fp.x, f.cur.z - _fp.z); if (s > best) { best = s; who = f; } }
        }
        return { slack: best, fielder: who };
    }

    // ── batted ball ──────────────────────────────────────
    function startFlight(G, info) {
        const type = G.hitType; if (!type) return;
        actors.fielders.forEach(f => { const d = info && info.defByPos && info.defByPos[f.pos]; f.defF = d ? clamp(1 + (d - 60) * 0.006, 0.78, 1.25) : 1; });
        const R = Math.random;
        let th = clamp(G.hitFlyDir * 0.5, -0.72, 0.72);
        const dir = new THREE.Vector3(Math.sin(th), 0, -Math.cos(th));
        const start = new THREE.Vector3(clamp(G.curX, -1.5, 1.5) * 0.31, 0.85, -0.15);
        let kind, dist, apex, dur, roll = 0, rollDist = 0;
        if (type === 'FOUL') {                         // tipped / glanced: a short ball into foul territory
            const sgn = Math.sign(G.hitFlyDir) || 1; th = sgn * (0.95 + R() * 0.35);
            dir.set(Math.sin(th), 0, -Math.cos(th)); kind = 'fly'; dist = 18 + R() * 26; apex = 10 + R() * 12; dur = 52;
        } else if (type === 'HR') { kind = 'fly'; dist = bowlR(th) + 18; apex = 38; dur = 112; }
        else if (type === '3B') {                        // into the gap and to the wall
            if (G.hitKind === 'line') { kind = 'line'; dist = 84 + R() * 12; apex = 8 + R() * 3; dur = 56; roll = 44; rollDist = 14; }
            else { kind = 'fly'; dist = 90 + R() * 10; apex = 26; dur = 84; roll = 44; rollDist = 12; }
        }
        else if (type === '2B') {
            if (G.hitKind === 'line') { kind = 'line'; dist = 70 + R() * 14; apex = 7 + R() * 3; dur = 52; roll = 36; rollDist = 18; }
            else { kind = 'fly'; dist = 78 + R() * 12; apex = 22; dur = 76; roll = 36; rollDist = 18; }
        }
        else if (type === '1B' && G.hitKind !== 'bunt') {
            if (G.hitKind === 'ground') { kind = 'grounder'; dist = 42; apex = 0.9; dur = 52; roll = 30; rollDist = 18; }
            else if (G.hitKind === 'line') { kind = 'line'; dist = 38 + R() * 12; apex = 3.5; dur = 34; roll = 28; rollDist = 14; }
            else { kind = 'fly'; dist = 36 + R() * 14; apex = 9; dur = 40; roll = 28; rollDist = 14; }
        } else if (G.hitKind === 'bunt') {                // a bunt dribbles into the infield grass
            th = clamp(G.hitFlyDir * 0.55, -0.55, 0.55); dir.set(Math.sin(th), 0, -Math.cos(th));
            kind = 'grounder'; dist = 5 + R() * 4; apex = 0.25; dur = 22; roll = 26; rollDist = 3 + R() * 2;      // deadened off the bat: a soft tap that dribbles to a stop
        } else { // OUT
            if (G.hitKind === 'ground') { kind = 'grounder'; dist = 26 + R() * 8; apex = 0.7; dur = 30; }
            else if (G.hitKind === 'pop') { kind = 'fly'; dist = 13 + R() * 6; apex = 26; dur = 68; }
            else if (G.hitKind === 'line') { kind = 'line'; dist = 28 + R() * 40; apex = 3 + R() * 3; dur = Math.round(30 + dist / 3); }
            else { kind = 'fly'; dist = 55 + R() * 28; apex = 30; dur = 84; }
        }
        let pickWho = null;
        if (type !== 'FOUL' && type !== 'HR' && G.hitKind !== 'bunt') {
            // fielding range: an out is hit where a fielder can get to it in time, a base hit drops where nobody can
            const fs = actors.fielders, hit = type !== 'OUT', nice = !!G.nicePlay && !hit;
            const mk = (th2, d2) => { const dr = new THREE.Vector3(Math.sin(th2), 0, -Math.cos(th2)); const e = start.clone().addScaledVector(dr, d2); e.y = 0; return { t0: 0, kind, start, dir: dr, dist: d2, apex, dur, roll, rollDist, end: e }; };
            let pick = null, best = null;
            for (let tries = 0; tries < 90 && !pick; tries++) {
                let th2, d2;
                if (!hit) {
                    const pool = fs.filter(f => (kind === 'grounder' || G.hitKind === 'pop') ? !/^(LF|CF|RF)$/.test(f.pos) : G.hitKind === 'fly' ? /^(LF|CF|RF)$/.test(f.pos) : true);      // a fly ball (sacrifice fly) is an outfield catch; an infielder's is a pop-up
                    const f = pool[Math.floor(R() * pool.length)], rr = fieldReach(kind, dur, f.defF) * 0.75;
                    const x = f.cur.x + (R() - 0.5) * 2 * rr, z = f.cur.z + (R() - 0.5) * 2 * rr;
                    d2 = Math.hypot(x, z); th2 = Math.atan2(x, -z);
                    if (!(Math.abs(th2) < 0.7 && (kind !== 'grounder' || d2 > 14) && d2 > 10)) continue;
                } else {
                    th2 = (R() - 0.5) * 1.4; d2 = Math.min(Math.max(dist * (0.82 + R() * 0.36), type === '3B' ? 80 : type === '2B' ? 64 : 0), bowlR(th2) - 8);      // extra-base hits land deep, never a shallow bloop
                }
                // (a grounder only just beyond reach with a man on first would look like a double play, so it must clear by more)
                const sl = catchSlack(mk(th2, d2)), score = hit ? -sl.slack : sl.slack;
                const good = hit ? sl.slack < (kind === 'fly' ? -3.5 : (kind === 'grounder' && G.runners && G.runners[0] && G.outs < 2) ? -4.5 : -1.5) : (sl.slack > 0.8 && (!nice || sl.slack < 3.5 || tries > 45));
                const cand = { th2, d2, who: sl.fielder, score };
                if (good) pick = cand; else if (!best || score > best.score) best = cand;
            }
            const ch = pick || best;
            if (ch) { th = ch.th2; dist = ch.d2; dir.set(Math.sin(th), 0, -Math.cos(th)); if (!hit) pickWho = ch.who; }
        }
        const end = start.clone().addScaledVector(dir, dist); end.y = 0;
        const landing = end.clone();
        const fl = { t0: G.frame, type, kind, start, dir, dist, apex, dur, roll, rollDist, end, landing, catch: type === 'OUT', fielder: null, arrive: 0, spin: rnd(0.3, 0.9) };
        // the fielder who plays it: the one with the best chance on an out, else whoever is nearest to where it stops
        const rest = roll ? end.clone().addScaledVector(dir, rollDist) : end;
        let best = null, bd = 1e9;
        actors.fielders.forEach(f => { const d = Math.hypot(f.cur.x - rest.x, f.cur.z - rest.z); if (d < bd) { bd = d; best = f; } });
        if (pickWho) best = pickWho;
        if (G.hitKind === 'bunt' && type !== 'FOUL') {          // whoever is closest of pitcher / catcher / corner men charges in
            let bb = null, bdd = 1e9; actors.fielders.forEach(f => { if (!/^(P|C|1B|3B)$/.test(f.pos)) return; const d = Math.hypot(f.cur.x - rest.x, f.cur.z - rest.z); if (d < bdd) { bdd = d; bb = f; } });
            if (bb) best = bb;
        }
        if (type !== 'HR' && type !== 'FOUL') {
            fl.fielder = best; fl.rest = rest;
            const isBunt = G.hitKind === 'bunt', react = isBunt ? 3 : kind === 'grounder' ? 12 : kind === 'line' ? 10 : 8;           // he breaks after this many frames, then runs flat out (same numbers as fieldReach)
            if (isBunt) {                                       // charges in at running pace and scoops it up where it stopped
                fl.pickT = dur + Math.round(roll * 0.7); flightPos(fl, G.frame + fl.pickT, _fp);
                for (let it = 0; it < 4; it++) {
                    const need = Math.ceil(react + Math.hypot(_fp.x - best.cur.x, _fp.z - best.cur.z) / 0.26);
                    if (need <= fl.pickT) break;
                    fl.pickT = need; flightPos(fl, G.frame + fl.pickT, _fp);
                }
                best.chase = { tx: _fp.x, tz: _fp.z, t0: G.frame, arrive: G.frame + fl.pickT, react };
                fl.hold = Math.max(0, fl.pickT - dur - 5);        // the throw waits until he has it
            }
            else if (fl.catch) best.chase = { tx: end.x, tz: end.z, t0: G.frame, arrive: G.frame + (G.hitKind === 'bunt' ? dur + 2 : dur - 2), react };
            else {                                             // a base hit: he reaches it while it is still rolling, as late as his legs make it
                fl.pickT = dur + Math.round(roll * 0.55); flightPos(fl, G.frame + fl.pickT, _fp);
                for (let it = 0; it < 4; it++) {
                    const need = Math.ceil(react + Math.hypot(_fp.x - best.cur.x, _fp.z - best.cur.z) / 0.25);
                    if (need <= fl.pickT) break;
                    fl.pickT = need; flightPos(fl, G.frame + fl.pickT, _fp);
                }
                best.chase = { tx: _fp.x, tz: _fp.z, t0: G.frame, arrive: G.frame + fl.pickT, react };
            }
            fl.nice = !!G.nicePlay && type === 'OUT'; fl.dp = !!G.dpPlay && type === 'OUT';
            if (!isBunt) fl.hold = fl.nice && kind === 'grounder' ? 12 : 0;                          // a diving stop takes a moment to get up and throw
            if (type === 'OUT' && kind === 'grounder') setupLegs(fl, best, G);
            else setupAirLegs(fl, best);
        }
        S.flight = fl;
        // contact flash + shake
        flashSprite.position.copy(start); flashSprite.material.opacity = 1; S.flashT = 0;
        S.shake = type === 'HR' ? 0.9 : G.hitKind === 'bunt' ? 0.12 : 0.5;
        if (type === 'HR') S.celebrate = 1;
    }


    // ── ground-out / double-play throws ──────────────────
    const BAG = [0, 1, 2, 3].map(i => ({ x: BASES[i][0], z: BASES[i][1] }));
    function setupLegs(fl, f, G) {
        let one = actors.fielders.find(p => p.pos === '1B'); const g0 = fl.dur + 5 + (fl.hold || 0);   // leg times are relative to the hit
        fl.legs = [];
        if (fl.dp) {
            const cover = actors.fielders.find(p => p.pos === (f.pos === 'SS' ? '2B' : 'SS'));
            if (cover && one && cover !== f) {
                fl.legs.push({ from: f, to: cover, at: { x: BAG[2].x - 0.5, z: BAG[2].z + 0.7 }, t0: g0, d: 14 });
                fl.legs.push({ from: cover, to: one, at: { x: BAG[1].x - 0.3, z: BAG[1].z + 0.6 }, t0: g0 + 17, d: 14 });
                cover.chase = { tx: BAG[2].x - 0.5, tz: BAG[2].z + 0.7, t0: fl.t0, arrive: fl.t0 + fl.dur + 5 };
                one.chase = { tx: BAG[1].x - 0.3, tz: BAG[1].z + 0.6, t0: fl.t0, arrive: fl.t0 + fl.dur + 24 };
                fl.cover = cover; fl.one = one;
            }
        } else if (one && (one !== f || actors.fielders.find(p => p.pos === '2B'))) {
            if (one === f) one = actors.fielders.find(p => p.pos === '2B');
            fl.legs.push({ from: f, to: one, at: { x: BAG[1].x - 0.3, z: BAG[1].z + 0.6 }, t0: g0, d: 16 });
            one.chase = { tx: BAG[1].x - 0.3, tz: BAG[1].z + 0.6, t0: fl.t0, arrive: fl.t0 + fl.dur + 12 };
            fl.one = one;
        }
        fl.holder = f;
        // the batter runs to first (and is out when the ball gets there); in a double play the runner from first is forced at second
        const arrive = (fl.legs.length ? fl.legs[fl.legs.length - 1].t0 + fl.legs[fl.legs.length - 1].d : fl.t0 + fl.dur + 14) - fl.t0;
        const o = actors.extras.find(q => !q.root.visible && !q.runnerBusy);
        if (o) { o.root.visible = true; o.runnerBusy = true; o.root.position.set(-0.9, 0, 0.1); o.path = [[BAG[1].x, BAG[1].z]]; o.spd = Math.max(0.3, Math.hypot(BAG[1].x + 0.9, BAG[1].z - 0.1) / (arrive + 3)); o.leaving = true; o.fast = false; o.arrived = false; o.phase = 0; o.stealing = false; }
        S.legCleanup = true;
    }

    // after a catch or a fielded base hit: the ball goes to a base / a teammate
    function setupAirLegs(fl, f) {
        const F = k => actors.fielders.find(p => p.pos === k), isIn = p => !/^(LF|CF|RF)$/.test(p.pos), hit = !fl.catch;
        const fx = f.chase.tx, fz = f.chase.tz;
        let recv, at;
        if (hit && fl.type === '1B' && isIn(f)) { recv = F('1B'); at = { x: BAG[1].x - 0.3, z: BAG[1].z + 0.6 }; }
        else if (!hit && isIn(f)) {                              // caught in the infield: a toss to the nearest other infielder
            recv = actors.fielders.filter(p => p !== f && isIn(p)).sort((a, b) => Math.hypot(a.cur.x - fx, a.cur.z - fz) - Math.hypot(b.cur.x - fx, b.cur.z - fz))[0];
            if (recv) at = { x: recv.cur.x, z: recv.cur.z };
        } else { recv = fx >= 0 ? F('2B') : F('SS'); at = { x: BAG[2].x - 0.5, z: BAG[2].z + 0.7 }; }     // outfielder: throw it in to second
        if (!recv || recv === f) return;
        const rel = (hit ? fl.pickT : fl.dur - 2) + 6, d = clamp(Math.round(Math.hypot(at.x - fx, at.z - fz) / 2.4), 9, 34);
        fl.legs = [{ from: f, to: recv, at, t0: rel, d, h: clamp(d * 0.12, 1.2, 3.4) }];
        recv.chase = { tx: at.x, tz: at.z, t0: fl.t0, arrive: fl.t0 + rel };
        if (hit && fl.type === '3B' && !isIn(f)) {              // a triple: relay man at the cutoff, then on to third
            const third = F('3B'), cut = { x: fx * 0.45, z: fz * 0.45 + 4 }, d1 = clamp(Math.round(Math.hypot(cut.x - fx, cut.z - fz) / 2.4), 9, 34);
            const relay = fx >= 0 ? F('2B') : F('SS');
            if (third && relay && relay !== third) {
                const at3 = { x: BAG[3].x + 0.5, z: BAG[3].z + 0.7 }, d2 = clamp(Math.round(Math.hypot(at3.x - cut.x, at3.z - cut.z) / 2.4), 9, 30);
                fl.legs = [{ from: f, to: relay, at: cut, t0: rel, d: d1, h: clamp(d1 * 0.12, 1.2, 3.4) }, { from: relay, to: third, at: at3, t0: rel + d1 + 3, d: d2, h: 1.6 }];
                relay.chase = { tx: cut.x, tz: cut.z, t0: fl.t0, arrive: fl.t0 + rel }; third.chase = { tx: at3.x, tz: at3.z, t0: fl.t0, arrive: fl.t0 + rel + d1 };
            }
        }
        fl.holder = f;
    }

    // thrower: wind-up then release toward (tx, tz); u in 0..1
    function throwPose(p, tx, tz, u) {
        faceToward(p, tx, tz);
        const P = Object.assign({}, P_FIELD, { torsoX: 0.25 - 0.5 * u, hipL: 0.6 * u, kneeL: 0.5 - 0.3 * u, crouch: 0.1 }); applyPose(p, P);
        p.root.updateMatrixWorld(true);
        const dx = tx - p.root.position.x, dz = tz - p.root.position.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d, w = u < 0.45 ? u / 0.45 : 1;
        const back = [p.root.position.x - ux * 0.55, 1.75, p.root.position.z - uz * 0.55], fwd = [p.root.position.x + ux * 0.8, 1.55, p.root.position.z + uz * 0.8];
        const k = u < 0.45 ? 0 : (u - 0.45) / 0.55;
        v1.set(lerp(back[0], fwd[0], k), lerp(back[1], fwd[1], k), lerp(back[2], fwd[2], k));
        ikArm(p.armR, v1, _hintDown.set(-0.3, -0.5, 0)); _hintDown.set(0, -1, 0);
    }

    function updateLegs(G, fl, t) {
        if (!fl.legs || !fl.legs.length) return null;
        // where is the ball? in a glove, or flying between two players
        let holder = fl.fielder, pos = null;
        for (const leg of fl.legs) {
            const u = (t - leg.t0) / leg.d;
            if (u >= 1) { holder = leg.to; continue; }
            if (u >= 0) {
                v2.set(leg.from.root.position.x, 1.5, leg.from.root.position.z); v3.set(leg.at.x, 1.25, leg.at.z);
                pos = hitBall.position.copy(v2).lerp(v3, u); pos.y += Math.sin(u * Math.PI) * (leg.h || 1.2);   // a flat, quick throw
            }
            break;
        }
        return { holder, pos };
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
        hitBall.scale.setScalar(0.06 * clamp(hitBall.position.distanceTo(camera.position) / 11, 1, 4.5));      // keep it readable when the camera is far away
        // catch: ball sticks to the fielder's glove
        if (((fl.catch && fl.pickT === undefined) ? t >= fl.dur - 1 : (fl.pickT !== undefined && t >= fl.pickT)) && fl.fielder) {
            const st = updateLegs(G, fl, t), f = (st && st.holder) || fl.fielder;
            if (st && st.pos) { /* ball already positioned mid-throw */ }
            else { f.gloveG.getWorldPosition(v1); hitBall.position.copy(v1); }
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
                const c = f.chase, rc = c.react || 0, span = Math.max(1, c.arrive - c.t0 - rc), k = clamp((G.frame - c.t0 - rc) / span, 0, 1), kk = rc ? k : easeOut(k);      // with a reaction time he runs at a steady pace, so a ball he cannot reach visibly gets past him
                tx = lerp(f.home.x, c.tx, kk); tz = lerp(f.home.z, c.tz, kk); sp = 0;
                const moving = k < 0.98;
                f.cur.x = tx; f.cur.z = tz; f.root.position.x = tx; f.root.position.z = tz;
                if (moving) faceToward(f, c.tx, c.tz);
                else faceToward(f, 0, 0);
                if (moving) { f.phase += 0.55 * df; applyPose(f, runPose({}, f.phase, 1)); }
                else { f.phase += 0.04 * df; applyPose(f, P_FIELD); }
                f.root.rotation.x = 0; f.root.position.y = 0;
                // spectacular play: lay out for the ball
                const ft = fl ? G.frame - fl.t0 : 0;
                if (fl && fl.nice && fl.fielder === f) {
                    const u = clamp((ft - (fl.dur - 10)) / 10, 0, 1), rec = clamp((ft - (fl.dur + 14 + (fl.hold || 0))) / 12, 0, 1), amt = ease(u) * (1 - ease(rec));
                    if (amt > 0.01) {
                        faceToward(f, fl.end.x, fl.end.z);
                        applyPose(f, { crouch: 0.2, torsoX: 0.2, hipL: -0.3, hipR: -0.35, kneeL: 0.2, kneeR: 0.3, armL: 2.3, armR: 2.0, elbL: 0.1, elbR: 0.2, absL: 0.3, absR: 0.3 });
                        f.root.rotation.x = 1.3 * amt; f.root.position.y = 0.5 * amt;
                    }
                }
                f.root.updateMatrixWorld(true);
                if (fl && fl.catch && fl.fielder === f && k >= 0.9) { // glove up to the ball
                    ikArm(f.armL, hitBall.position, _hintDown.set(0.3, -1, 0)); _hintDown.set(0, -1, 0);
                }
                // throwing / receiving on a ground out or a double play
                if (fl && fl.legs && fl.legs.length) {
                    for (const leg of fl.legs) {
                        const u = (ft - leg.t0 + 4) / (leg.d + 4);
                        if (leg.from === f && u > 0 && u < 1.15) { throwPose(f, leg.at.x, leg.at.z, clamp(u, 0, 1)); }
                        else if (leg.to === f && ft >= leg.t0 && ft < leg.t0 + leg.d + 10) {
                            faceToward(f, leg.from.root.position.x, leg.from.root.position.z); f.root.updateMatrixWorld(true);
                            ikArm(f.armL, v1.set(f.root.position.x + (leg.from.root.position.x - f.root.position.x) * 0.12, 1.3, f.root.position.z + (leg.from.root.position.z - f.root.position.z) * 0.12), _hintDown.set(0.3, -1, 0)); _hintDown.set(0, -1, 0);
                        }
                    }
                }
                return;
            }
            if (!fl || !f.chase) f.chase = null;
            f.root.rotation.x = 0; f.root.position.y = 0;
            if (!f.base0) f.base0 = { x: f.home.x, z: f.home.z };
            if (!fl && info.batter) {
                // pre-pitch positioning: pull-side shift and depth by the batter's power (the shifted spot becomes the fielder's new base)
                const pull = (info.batSide || info.batter.bats) === 'L' ? 1 : -1, out = /^(LF|CF|RF)$/.test(f.pos), pw = info.batter.pow || 60;
                const gx = f.base0.x + pull * (out ? 5 : 2.2) * (f.pos === '1B' ? 0.3 : 1), gz = f.base0.z - (out ? clamp((pw - 60) / 6, -4, 6) : 0);
                f.home.x += (gx - f.home.x) * 0.03 * df; f.home.z += (gz - f.home.z) * 0.03 * df;
            }
            if (fl && fl.type !== 'FOUL' && fl.fielder !== f) {
                // everybody else breaks toward the ball a few metres (first step / backing up)
                const k = clamp((G.frame - fl.t0) / 30, 0, 1), bx = fl.landing.x, bz = fl.landing.z, d = Math.hypot(bx - f.home.x, bz - f.home.z) || 1, mv = Math.min(5, d * 0.3) * ease(k);
                const tx2 = f.home.x + (bx - f.home.x) / d * mv, tz2 = f.home.z + (bz - f.home.z) / d * mv;
                f.cur.x += (tx2 - f.cur.x) * 0.12 * df; f.cur.z += (tz2 - f.cur.z) * 0.12 * df;
                f.root.position.x = f.cur.x; f.root.position.z = f.cur.z; faceToward(f, bx, bz);
                f.phase += 0.4 * df; applyPose(f, runPose({}, f.phase, 0.7)); f.root.visible = true; return;
            }
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
        const left = (info.batSide || info.batter.bats) === 'L', mr = left ? -1 : 1; S.batLeft = left;   // mr mirrors the right-handed pose for lefties
        wrap.scale.x = 1;
        p.root.position.x = -0.95 * mr; p.root.rotation.y = mr * Math.PI / 2;
        // swing progress
        let s = -1;
        if (G.batSwingFrame >= 0 && G.frame - G.batSwingFrame < 60) s = (G.frame - G.batSwingFrame) / 20 + 0.28;
        else if (!info.humanBatting && G.aiSwing && G.frame >= G.aiSwingFrame - 8 && G.ballActive) s = (G.frame - (G.aiSwingFrame - 8)) / 20 + 0.28;
        s = s >= 0 ? Math.min(s, 1.4) : -1;
        const bunT = info.buntT, buntAct = bunT >= 0 && bunT < 34;      // the bunt itself: bat pushed out to meet the ball, then pulled back
        if (info.bunt || buntAct) s = -1;
        // right-handed reference pose: front (pitcher-side) leg = left leg
        const stance = { crouch: 0.14, torsoX: 0.22, torsoY: 0.08, hipsY: 0.12, hipL: 0.42, hipR: 0.38, kneeL: 0.78, kneeR: 0.85, spreadL: 0.34, spreadR: 0.34, headY: 1.2, headX: 0.08 };
        // each batter gets his own stance: archetype from stats, tweaked by a hash of his name so no two look quite alike
        const bt = info.batter || {}, nm = String(bt.name || ''); let hh = 7; for (let i = 0; i < nm.length; i++) hh = (hh * 31 + nm.charCodeAt(i)) >>> 0;
        const h1 = (hh % 97) / 97, h2 = ((hh >> 7) % 89) / 89, h3 = ((hh >> 13) % 83) / 83;
        const arch = (bt.pow || 0) >= 80 ? (h1 < 0.5 ? 1 : 4) : ((bt.con || 0) >= 75 && (bt.pow || 0) < 70) ? (h1 < 0.6 ? 2 : 3) : Math.floor(h1 * 5);
        const sty = { holdRz: 0, holdPy: 0, waggle: 1, kick: 0 };
        if (arch === 1) { stance.crouch += 0.12; stance.kneeL += 0.12; stance.kneeR += 0.12; stance.spreadL += 0.14; stance.spreadR += 0.14; stance.torsoX += 0.1; sty.holdRz = 0.1; }      // deep, wide power stance
        else if (arch === 2) { stance.crouch -= 0.08; stance.kneeL -= 0.2; stance.kneeR -= 0.2; stance.spreadL -= 0.08; stance.spreadR -= 0.08; stance.torsoX -= 0.08; sty.holdRz = -0.2; sty.holdPy = 0.08; }      // upright, bat held high
        else if (arch === 3) { stance.spreadL -= 0.12; stance.spreadR -= 0.12; stance.torsoY += 0.12; stance.hipsY += 0.08; sty.waggle = 3.2; sty.holdRz = 0.05; }      // narrow, open, big bat waggle
        else if (arch === 4) { sty.kick = 1; stance.crouch += 0.04; sty.waggle = 1.5; }      // leg kick timing mechanism
        stance.crouch += (h2 - 0.5) * 0.06; stance.spreadL += (h3 - 0.5) * 0.08; stance.spreadR += (h3 - 0.5) * 0.08; sty.holdRz += (h3 - 0.5) * 0.14; stance.torsoY += (h2 - 0.5) * 0.08;
        let P, hold = { rx: -0.05, rz: 0.55, ry: 0.0, px: -0.1, py: 0.4, pz: 0.12 };
        const wob = Math.sin(G.frame * 0.09 * (sty.waggle > 1 ? 1.6 : 1)) * 0.03 * sty.waggle;
        if (s < 0) {
            P = Object.assign({}, stance); P.torsoZ = wob; hold.rz += wob + sty.holdRz; hold.py += sty.holdPy;
            if (sty.kick) { const ph = (G.frame % 150) / 150, k = ph > 0.7 ? Math.sin((ph - 0.7) / 0.3 * Math.PI) : 0; P.hipL += 0.55 * k; P.kneeL += 0.5 * k; }
            if (info.bunt || buntAct) { P.torsoY = 1.3; P.hipsY = 1.0; P.headY = -1.1; P.torsoX = 0.35; P.torsoZ = 0; P.crouch = 0.3; P.kneeL = 1.0; P.kneeR = 1.0; P.hipL = 0.6; P.hipR = 0.55; P.spreadL = 0.5; P.spreadR = 0.5; hold = { rx: -0.35, rz: 1.35, ry: 0.0, px: 0.0, py: 0.6, pz: 0.72 };      }       // squared to the pitcher, bat flat across the front with the barrel over the plate
            if (buntAct) {
                const push = bunT < 9 ? Math.sin(bunT / 9 * Math.PI / 2) : Math.max(0, 1 - (bunT - 9) / 14), hit = bunT < 9 ? 0 : Math.max(0, 1 - (bunT - 9) / 8);
                hold.pz = 0.72 + 0.28 * push; hold.py = 0.6 - 0.08 * push; hold.rx = -0.35 - 0.2 * push + 0.15 * hit;      // reach out, then cushion back on contact
                P.torsoX += 0.2 * push; P.kneeL += 0.22 * push; P.kneeR += 0.22 * push; P.crouch += 0.1 * push;
            }
        } else {
            const T = clamp(s, 0, 1), e = ease(clamp(T / 0.9, 0, 1));
            P = Object.assign({}, stance);
            P.hipsY = lerp(stance.hipsY, 1.15, ease(clamp(T / 0.7, 0, 1)));
            P.torsoY = lerp(stance.torsoY, 1.3, e);
            P.headY = clamp(1.2 - P.hipsY - P.torsoY, -0.9, 1.3);
            P.hipL = lerp(stance.hipL, 0.7, e); P.kneeL = lerp(stance.kneeL, 0.35, e); P.kneeR = lerp(stance.kneeR, 1.1, e); P.hipR = lerp(stance.hipR, -0.1, e);
            P.torsoX = lerp(stance.torsoX, 0.2, e);
            hold = { rx: lerp(-0.05, -0.12, e), rz: lerp(0.55 + sty.holdRz, -1.52, ease(clamp(T / 0.55, 0, 1))), ry: lerp(0, 0.25, e), px: lerp(-0.1, 0.0, e), py: lerp(0.4 + sty.holdPy, 0.34, e), pz: lerp(0.12, 0.34, e) };
        }
        if (left) { // mirror: swap legs, flip every lateral rotation
            [P.hipL, P.hipR] = [P.hipR, P.hipL]; [P.kneeL, P.kneeR] = [P.kneeR, P.kneeL];
            P.torsoY *= -1; P.hipsY *= -1; P.headY *= -1; P.torsoZ = -(P.torsoZ || 0);
            hold.rz *= -1; hold.ry *= -1; hold.px *= -1;
        }
        applyPose(p, P);
        p.guards.forEach(gd => gd.visible = false); p.guards[left ? 1 : 0].visible = true;   // lead elbow: left arm for righties, right arm for lefties
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

    // ── stealing a base: sprint, slide, dust ──────────────
    function slidePose(P) {
        return Object.assign(P, { crouch: 0.62, torsoX: -0.7, hipL: 1.35, kneeL: 0.12, hipR: 0.3, kneeR: 1.7, spreadL: 0.05, spreadR: 0.2, armL: 2.3, elbL: 0.3, armR: 1.9, elbR: 0.4, absL: 0.3, absR: 0.3 });
    }
    function dust(x, z, n = 16) {
        for (let i = 0; i < n; i++) {
            const a = rnd(0, Math.PI * 2), sp = rnd(1, 3.6);
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xc9a06a, transparent: true, depthWrite: false, opacity: 0.7 }));
            s.position.set(x, 0.12, z); s.scale.set(0.9, 0.9, 1); scene.add(s);
            particles.push({ s, v: new THREE.Vector3(Math.cos(a) * sp, rnd(0.3, 1.8), Math.sin(a) * sp), life: 0.9 });
        }
    }
    function stealRunners(G, st, holdPos, pool) {
        if (S.stealInit !== st.t0) {
            S.stealInit = st.t0; S.stealRun = [];
            if (!S.runnerObjs) S.runnerObjs = [null, null, null];
            st.moves.forEach(m => {
                let o = S.runnerObjs[m.k];
                if (!o) {
                    o = pool.find(q => !q.root.visible && !q.runnerBusy); if (!o) return;
                    const hp = holdPos(m.k); o.root.visible = true; o.runnerBusy = true; o.root.position.set(hp.x, 0, hp.z); o.path = []; S.runnerObjs[m.k] = o;
                }
                const to = BASES[(m.k + 2) % 4], lead = m.k === st.leadK;
                const arr = m.res === 'out' && lead ? Math.max(30, st.ballArrive + 3) : st.R;       // caught runners arrive just after the ball
                S.stealRun.push({ k: m.k, o, res: m.res, from: { x: o.root.position.x, z: o.root.position.z }, to: { x: to[0], z: to[1] }, arr, phase: 0, dusted: false });
            });
        }
        const t = G.frame - st.t0;
        (S.stealRun || []).forEach(e => {
            const o = e.o; o.stealing = true; o.path = [];
            const u = clamp(t / e.arr, 0, 1), acc = u < 1 ? 0.45 * u + 0.55 * u * u : 1;                // accelerates out of the lead
            const reach = e.res === 'stay' ? 0.3 * Math.sin(Math.PI * u) : acc;
            o.root.position.x = lerp(e.from.x, e.to.x, reach); o.root.position.z = lerp(e.from.z, e.to.z, reach);
            const tx = e.res === 'stay' && u > 0.5 ? e.from.x : e.to.x, tz = e.res === 'stay' && u > 0.5 ? e.from.z : e.to.z;
            if (u < 1) faceToward(o, tx, tz);
            const sliding = e.res !== 'stay' && t > e.arr - 14 && t < e.arr + 14;
            if (sliding) {
                applyPose(o, slidePose({}));
                if (!e.dusted && t >= e.arr - 2) { e.dusted = true; dust(e.to.x, e.to.z, e.res === 'out' ? 22 : 16); }
            } else if (u < 1 || (e.res === 'stay' && u < 1)) { e.phase += 0.7 * df_(); applyPose(o, runPose({}, e.phase, 1)); }
            else applyPose(o, P_LEAD);
            o.root.updateMatrixWorld(true);
        });
    }
    let _df = 1; function df_() { return _df; }

    // defenders, catcher and the throw during a steal (runs late in the frame so it overrides the idle poses)
    function stealActors(G, info, dt, df) {
        const st = G.phase === info.PH.STEAL ? G.steal : null;
        if (!st) { S.stealCoverF = null; return; }
        _df = df;
        const t = G.frame - st.t0, k = st.leadK, bi = (k + 2) % 4, base = BASES[bi], cat = actors.catcher;
        // covering fielder runs to the bag and waits with the glove down
        const d = Math.hypot(base[0], base[1]) || 1, cx = base[0] - base[0] / d * 0.9, cz = base[1] - base[1] / d * 0.9;
        let f = null; if (bi === 2) f = actors.fielders.find(p => p.pos === st.cover); else if (bi === 3) f = actors.fielders.find(p => p.pos === '3B');
        if (f) {
            const u = easeOut(clamp(t / 30, 0, 1));
            f.root.position.x = lerp(f.home.x, cx, u); f.root.position.z = lerp(f.home.z, cz, u); f.cur.x = f.root.position.x; f.cur.z = f.root.position.z;
            faceToward(f, 0, 0);
            if (u < 1) { f.phase += 0.55 * df; applyPose(f, runPose({}, f.phase, 1)); } else applyPose(f, P_FIELD);
            f.root.updateMatrixWorld(true);
            const reach = t >= st.ballArrive - 5;
            ikArm(f.armL, v1.set(base[0], reach ? 0.3 : 0.75, base[1]), _hintDown.set(0.3, -1, 0.2)); _hintDown.set(0, -1, 0);
            S.stealCoverF = f;
        }
        // catcher: receives the pitch, springs up and fires to the base (nothing to throw on a steal of home)
        if (bi !== 0 && t >= 26) {
            const p = clamp((t - 26) / 12, 0, 1);
            applyPose(cat, Object.assign({}, P_STAND, { crouch: 0.1 * (1 - p), torsoX: 0.25 }));
            cat.root.rotation.y = lerp(Math.PI, Math.atan2(base[0], base[1] - 0.95), clamp(p * 2, 0, 1));
            cat.root.updateMatrixWorld(true);
            const wind = [-0.25, 1.72, -0.3], rel = [-0.1, 1.62, 0.6], fol = [0.05, 1.0, 0.55];
            const q = p < 0.45 ? wind : p < 0.8 ? rel : fol;
            cat.root.localToWorld(v2.set(q[0], q[1], q[2]));
            ikArm(cat.armR, v2, _hintDown.set(-0.4, -1, -0.3));
            cat.root.localToWorld(v2.set(0.25, 1.2, 0.3)); ikArm(cat.armL, v2, _hintDown.set(0.4, -1, 0.2)); _hintDown.set(0, -1, 0);
        }
        // the throw
        const t0 = 31;
        if (bi !== 0 && t >= t0) {
            const u = clamp((t - t0) / Math.max(6, st.ballArrive - t0), 0, 1);
            v1.set(0.1, 1.6, 0.4); v3.set(base[0], 0.55, base[1]);
            hitBall.position.copy(v1).lerp(v3, u); hitBall.position.y += Math.sin(u * Math.PI) * 1.4; hitBall.visible = true; hitBall.rotation.x += 0.6;
            ball.visible = false;
            ballShadow.visible = u < 1; ballShadow.position.set(hitBall.position.x, 0.03, hitBall.position.z); ballShadow.scale.set(0.35, 0.35, 1);
        }
    }

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
        const st = G.phase === info.PH.STEAL ? G.steal : null;
        if (!st) { S.stealRun = null; pool.forEach(o => o.stealing = false); } else stealRunners(G, st, holdPos, pool);
        if (!phaseHR && !st) {
            let changed = false; for (let k = 0; k < 3; k++) if (prev[k] !== now[k]) changed = true;
            // bases loaded + a walk / hit-by-pitch: everyone is forced up a base and the runner from third walks home
            if (!changed && prev[0] && prev[1] && prev[2] && S.runnerObjs[2] && G.score[G.half] > (S.prevScore ? S.prevScore[G.half] : 0) && G.phase !== info.PH.HR_RUN) {
                const o3 = S.runnerObjs[2];
                o3.path = [BASES[0]]; o3.arrived = false; o3.leaving = true; o3.fast = false;
                for (const k of [1, 0]) { const o = S.runnerObjs[k]; if (!o) continue; const hp = holdPos(k + 1); o.path = [BASES[k + 2], [hp.x, hp.z]]; o.arrived = false; o.slot = k + 1; S.runnerObjs[k + 1] = o; }
                S.runnerObjs[0] = spawn(0, 0);
            }
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
                    else if (S.flight && S.flight.dp && k === 0) {          // double play: the runner from first is forced at second
                        o.path = [[BASES[2][0], BASES[2][1]]]; o.spd = Math.hypot(o.root.position.x - BASES[2][0], o.root.position.z - BASES[2][1]) / (S.flight.dur + 19);
                        o.leaving = true; o.fast = false; o.arrived = false;
                    }
                    else releaseRunner(o);
                });
                for (let k = 0; k < 3; k++) if (now[k] && !newObjs[k]) newObjs[k] = spawn(0, k);
                S.runnerObjs = newObjs;
                // a base hit: run so as to beat the throw, not to stroll in after the ball is already at the bag
                const hf = S.flight;
                if (hf && (hf.type === '1B' || hf.type === '2B' || hf.type === '3B') && hf.legs && hf.legs.length) {
                    const lg = hf.legs[hf.legs.length - 1], target = Math.max(36, lg.t0 + lg.d - Math.max(0, G.frame - hf.t0) - 8);
                    pool.forEach(o => {
                        if (!o.root.visible || !o.path || !o.path.length || o.spd) return;
                        let len = 0, px = o.root.position.x, pz = o.root.position.z;
                        o.path.forEach(q => { len += Math.hypot(q[0] - px, q[1] - pz); px = q[0]; pz = q[1]; });
                        o.spd = clamp(len / target, 0.34, 0.9);
                    });
                }
            }
            S.runnersPrev = now;
        } else if (phaseHR && !S.hrHandled) {
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
            if (!o.root.visible || o.stealing) return;
            if (!o.path || !o.path.length) { // standing at base
                applyPose(o, P_LEAD); o.phase += 0.05 * df; o.root.position.y = 0;
                faceToward(o, 0, MOUND_Z);   // a runner leading off watches the pitcher o.hips.position.y += Math.sin(o.phase) * 0.01;
                return;
            }
            const sp = (o.spd || (o.fast ? 0.62 : 0.34)) * df;
            let step = sp;
            while (step > 0 && o.path.length) {
                const tgt = o.path[0], dx = tgt[0] - o.root.position.x, dz = tgt[1] - o.root.position.z, d = Math.hypot(dx, dz);
                if (d <= step) { o.root.position.x = tgt[0]; o.root.position.z = tgt[1]; o.path.shift(); step -= d; }
                else { o.root.position.x += dx / d * step; o.root.position.z += dz / d * step; faceToward(o, tgt[0], tgt[1]); step = 0; }
            }
            o.phase += 0.62 * df; applyPose(o, runPose({}, o.phase, 1));
            if (!o.path.length && !o.leaving) o.spd = 0;
            if (!o.path.length && o.leaving) releaseRunner(o);
        });
        // colours
        const home = G.half === 1; // bottom half → home team bats
        pool.forEach(o => { if (o.root.visible) dressTeam(o, info.batTeam, home, { helmet: true }); });
    }
    function releaseRunner(o) { o.root.visible = false; o.runnerBusy = false; o.path = []; o.leaving = false; o.fast = false; o.spd = 0; }

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
    // brief cut to the umpire for the big calls only: strikeouts and foul balls (other calls are visible on the video board)
    function umpGestureCut(G, PH) { const g = umpGesture(G, PH); return !!g && (g.kind === 'strike3' || g.kind === 'foul') && g.e < 52 && !(S.flight && S.flight.type !== 'FOUL' && hitBall.visible); }
    function cameraTarget(G, info) {
        const PH = info.PH; let tgt;
        const fl = S.flight;
        const flying = fl && fl.type !== 'FOUL' && (G.frame - fl.t0) < fl.dur + fl.roll + 10 && hitBall.visible;
        const pc = fl && fl.type === 'OUT' ? playCam(fl, G) : null;
        if (pc && (G.phase === PH.RESULT || G.phase === PH.BATTING)) tgt = pc;
        else if (G.phase === PH.HR_RUN || (fl && fl.type === 'HR' && G.phase === PH.RESULT)) {
            if (fl && G.frame - fl.t0 < fl.dur * 0.62) tgt = followCam(fl, G);
            else tgt = HRCAM;
        } else if (flying && G.phase === PH.RESULT) tgt = followCam(fl, G);
        else if (G.phase === PH.RESULT && (G.resSub === 'HIT' || G.resSub === '2 BASE HIT' || G.resSub === '3 BASE HIT' || G.resSub === 'OUT' || G.resSub === 'WALK')) tgt = flying ? followCam(fl, G) : (G.resSub === 'WALK' ? BAT_CAM : WIDE);
        else if (G.phase === PH.STEAL) tgt = stealCam(G);
        else if (umpGestureCut(G, PH)) { UMP_CAM.pos.x = S.batLeft ? -4.2 : 4.2; UMP_CAM.look.x = S.batLeft ? 0.1 : -0.1; UMP_CAM.look.y = 2.7; tgt = UMP_CAM; }
        else if (G.phase === PH.INNING_START) tgt = WIDE;
        else tgt = info.pitchView ? PITCH_CAM : BAT_CAM;
        return tgt;
    }
    const STEAL_CAM = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 38, shift: 0 };
    function stealCam(G) {
        const e = S.stealRun && (S.stealRun.find(x => x.k === G.steal.leadK) || S.stealRun[0]);
        if (!e) return WIDE;
        if (G.steal.moves.length > 1) { STEAL_CAM.look.set(0, 1.0, -22); STEAL_CAM.pos.set(-4, 13, 20); STEAL_CAM.fov = 58; return STEAL_CAM; }   // double steal: show the whole diamond
        STEAL_CAM.fov = 38;
        const p = e.o.root.position;
        STEAL_CAM.look.set(lerp(p.x, e.to.x, 0.35), 1.0, lerp(p.z, e.to.z, 0.35));
        const side = e.k === 0 ? -1 : 1;
        STEAL_CAM.pos.set(STEAL_CAM.look.x + side * 15, 6.5, STEAL_CAM.look.z + 17);
        return STEAL_CAM;
    }

    // ── home-plate umpire: strike / ball / foul / walk signals ──────────────────────────
    function umpGesture(G, PH) {
        if (G.phase !== PH.RESULT) return null;
        const e = 95 - G.resTimer;
        switch (G.resSub) {
            case 'STRIKE': case 'SWINGING STRIKE': return { kind: 'strike', e };
            case 'STRIKEOUT': return { kind: 'strike3', e };
            case 'BALL': return { kind: 'ball', e };
            case 'FOUL BALL': return { kind: 'foul', e };
            case 'WALK': return { kind: 'walk', e };
        }
        return null;
    }
    function updateUmpire(G, info) {
        const u = actors.umpire, g = umpGesture(G, info.PH);
        const P = Object.assign({}, P_UMP);
        let r = null, l = null, headY = 0;
        const at = (x, y, z) => u.root.localToWorld(v2.set(x, y, z)).clone();
        if (g) {
            const e = g.e, ease_ = x => clamp(x, 0, 1);
            Object.assign(P, { crouch: 0.03, torsoX: 0.12, hipL: 0.1, hipR: 0.1, kneeL: 0.12, kneeR: 0.12 });   // stand up to make the call
            if (g.kind === 'strike' || g.kind === 'strike3') {
                // raise the right fist beside the head, then punch it forward (3 quick punches on a strikeout)
                const up = ease_(e / 8), hits = g.kind === 'strike3' ? 3 : 1, ph = (e - 8) / 9;
                const punch = e > 8 ? Math.max(0, Math.sin(Math.min(ph, hits) * Math.PI * 2)) : 0;
                r = at(-0.3, lerp(1.35, 1.82, up) - 0.1 * punch, 0.12 + 0.55 * punch);
                if (g.kind === 'strike3') headY = 0;
            } else if (g.kind === 'ball') {
                // no big signal for a ball: a small outward wave of the open left hand + a shake of the head
                const w = Math.sin(e * 0.5) * 0.1, up = ease_(e / 6);
                l = at(0.5 + w, lerp(1.25, 1.5, up), 0.35); headY = Math.sin(e * 0.45) * 0.35 * up;
            } else if (g.kind === 'foul') {
                const up = ease_(e / 7), w = Math.sin(e * 0.55) * 0.08;
                r = at(-0.25 + w, lerp(1.3, 2.3, up), 0.1); l = at(0.25 - w, lerp(1.3, 2.3, up), 0.1);       // both arms overhead
            } else if (g.kind === 'walk') {
                const up = ease_(e / 8);                                                                       // point toward first base
                r = at(-0.7 * up - 0.1, 1.55, -0.05 + 0.15 * up); headY = -0.4 * up;
            }
        }
        applyPose(u, P);
        u.head.rotation.y = headY;
        u.root.updateMatrixWorld(true);
        if (r) { ikArm(u.armR, r, _hintDown.set(-0.6, -0.5, -0.3)); _hintDown.set(0, -1, 0); }
        if (l) { ikArm(u.armL, l, _hintDown.set(0.5, -0.6, -0.2)); _hintDown.set(0, -1, 0); }
    }
    const UMP_CAM = { pos: new THREE.Vector3(4.2, 2.0, -6.0), look: new THREE.Vector3(-0.1, 2.7, 2.0), fov: 22, shift: 0 };

    const NICE_CAM = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 30, shift: 0 };
    const DP_CAM = { pos: new THREE.Vector3(-17, 7.5, -2), look: new THREE.Vector3(0.5, 1.0, -21), fov: 44, shift: 0 };
    function playCam(fl, G) {                        // returns a camera for the key moment of a defensive play, or null
        const t = G.frame - fl.t0;
        if (fl.nice && fl.fielder && t >= fl.dur - 20 && t < fl.dur + 52 + (fl.hold || 0)) {
            const p = fl.fielder.root.position, side = p.x >= 0 ? 1 : -1, back = p.z < -45 ? 1 : 0.6;
            NICE_CAM.look.set(p.x, 0.75, p.z); NICE_CAM.pos.set(p.x - side * 6.5 * back, 2.1, p.z + 9 * back); NICE_CAM.fov = 28; return NICE_CAM;
        }
        if (fl.legs && fl.legs.length && t >= fl.dur - 6 && t < fl.dur + 70) return DP_CAM;
        return null;
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
        if (S.dbgCam) { applyCamera(camera, S.dbgCam); S.nearBat = false; S.nearPitch = false; return; }
        const tgt = cameraTarget(G, info);
        const k = tgt === BAT_CAM ? 5.5 : (tgt === PITCH_CAM ? 4 : tgt === FOLLOW ? 7 : (tgt === STEAL_CAM ? 5 : (tgt === UMP_CAM ? 11 : (tgt === NICE_CAM || tgt === DP_CAM ? 6 : 3.2))));
        camS.pos.x = damp(camS.pos.x, tgt.pos.x, k, dt); camS.pos.y = damp(camS.pos.y, tgt.pos.y, k, dt); camS.pos.z = damp(camS.pos.z, tgt.pos.z, k, dt);
        camS.look.x = damp(camS.look.x, tgt.look.x, k * 1.2, dt); camS.look.y = damp(camS.look.y, tgt.look.y, k * 1.2, dt); camS.look.z = damp(camS.look.z, tgt.look.z, k * 1.2, dt);
        camS.fov = damp(camS.fov, tgt.fov, k, dt); camS.shift = damp(camS.shift, tgt.shift, k, dt);
        if (tgt === BAT_CAM) { // snap once settled so the zone overlay is pixel-exact
            if (camS.pos.distanceTo(BAT_CAM.pos) < 0.01 && Math.abs(camS.fov - BAT_CAM.fov) < 0.02 && Math.abs(camS.shift - 100) < 0.2) { camS.pos.copy(BAT_CAM.pos); camS.look.copy(BAT_CAM.look); camS.fov = BAT_CAM.fov; camS.shift = 100; }
        }
        const st = { pos: camS.pos, look: camS.look, fov: camS.fov, shift: camS.shift };
        if (S.shake > 0) { S.shake = Math.max(0, S.shake - dt * 2.2); st.pos = camS.pos.clone().add(v3.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(S.shake * 0.05)); }
        applyCamera(camera, st);
        if (tgt === PITCH_CAM) {      // snap once settled so the zone overlay is pixel-exact
            if (camS.pos.distanceTo(PITCH_CAM.pos) < 0.25 && Math.abs(camS.fov - PITCH_CAM.fov) < 0.03 && Math.abs(camS.shift - PITCH_CAM.shift) < 0.3) { camS.pos.copy(PITCH_CAM.pos); camS.look.copy(PITCH_CAM.look); camS.fov = PITCH_CAM.fov; camS.shift = PITCH_CAM.shift; S.nearPitch = true; } else S.nearPitch = false;
        } else S.nearPitch = false;
        if (tgt === PITCH_CAM) aimMode = 'pitch'; else if (tgt === BAT_CAM) aimMode = 'bat';
        S.camMode = tgt === BAT_CAM ? 'bat' : (tgt === PITCH_CAM ? 'pitch' : 'wide');
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
            pitchZoneCam = new THREE.PerspectiveCamera(5, 4 / 3, 0.2, 700);
            buildStadium(); buildActors();
            api.ok = true;
            api.debug = { scene, camera, renderer, S, actors };
        } catch (e) { console.error('Stadium3D init failed', e); api.ok = false; }
        return api.ok;
    };
    // test hook: sample many batted balls and report how often the landing logic fails to honour hit / out
    api._ball = () => ({ v: hitBall.visible, x: +hitBall.position.x.toFixed(1), y: +hitBall.position.y.toFixed(1), z: +hitBall.position.z.toFixed(1) });
    api._probe = function (n, defv) {
        const out = {}; const keep = S.flight;
        const cases = [['OUT', 'ground'], ['OUT', 'fly'], ['OUT', 'pop'], ['OUT', 'line'], ['1B', 'ground'], ['1B', 'line'], ['1B', 'fly'], ['2B', 'line'], ['2B', 'fly'], ['3B', 'line'], ['3B', 'fly']];
        for (const [type, hk] of cases) {
            let bad = 0, sl = 0, mx = 0, vs = 0, late = 0;
            for (let i = 0; i < n; i++) {
                startFlight({ hitType: type, hitKind: hk, hitFlyDir: (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.8), curX: 0, frame: 0, nicePlay: false, dpPlay: false, runners: [true, false, false], outs: 0 }, defv ? { defByPos: { P: defv, C: defv, '1B': defv, '2B': defv, '3B': defv, SS: defv, LF: defv, CF: defv, RF: defv } } : {});
                const fl = S.flight, c = { t0: 0, kind: fl.kind, start: fl.start, dir: fl.dir, dist: fl.dist, apex: fl.apex, dur: fl.dur, roll: fl.roll, rollDist: fl.rollDist, end: fl.end };
                const r = catchSlack(c); sl += r.slack;
                { const f = fl.fielder; if (f && f.chase) { const cc = f.chase, v = Math.hypot(cc.tx - f.home.x, cc.tz - f.home.z) / Math.max(1, cc.arrive - cc.t0 - cc.react); mx = Math.max(mx, v); vs += v; if (fl.pickT !== undefined && fl.pickT > fl.dur + Math.round(fl.roll * 0.55)) late++; } }
                if (type === 'OUT' ? r.slack <= 0 : r.slack >= 0) bad++;
            }
            out[type + '/' + hk] = { bad, avgSlack: +(sl / n).toFixed(2), maxV: +mx.toFixed(2), avgV: +(vs / n).toFixed(2), late };
        }
        S.flight = keep; return out;
    };
    api._who = function (type, hk, n) {       // test hook: who plays a batted ball of this kind
        const out = {}, keep = S.flight;
        for (let i = 0; i < n; i++) { startFlight({ hitType: type, hitKind: hk, hitFlyDir: (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.8), curX: 0, frame: 0, nicePlay: false, dpPlay: false }, {}); const f = S.flight.fielder; const k = f ? f.pos : '-'; out[k] = (out[k] || 0) + 1; }
        S.flight = keep; return out;
    };
    api.debugCam = function (pos, look, fov) { S.dbgCam = pos ? { pos: new THREE.Vector3(...pos), look: new THREE.Vector3(...look), fov: fov || 30, shift: 0 } : null; };
    api.pitchPoint = (G, t) => { const o = new THREE.Vector3(); pitchWorld(G, t, o); return [+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2)]; };
    api.resize = resize;
    api.pxToPlane = pxToPlane;
    // project a world point to game px using the (settled) batter camera
    const _pv = new THREE.Vector3();
    function worldToPx(x, y, z) {
        _pv.set(x, y, z).project(zoneCam);
        const cx = (_pv.x * 0.5 + 0.5) * cw, cy = (-_pv.y * 0.5 + 0.5) * ch;
        return { x: (cx - rect.x) / rect.w * GW, y: (cy - rect.y) / rect.h * GH };
    }
    // predicted pitch path (release -> plate, with break) as game-px points; same maths as pitchWorld()
    api.previewPath = function (ex, ey, cxPx, cyPx, n) {
        const E = pxToPlane(ex, ey, new THREE.Vector3()), pts = [], p = new THREE.Vector3();
        for (let i = 0; i <= n; i++) {
            const k = i / n;
            p.copy(REL).lerp(new THREE.Vector3(E.x + (cxPx / K) * k, E.y - (cyPx / K) * k, 0), k);
            p.y += Math.sin(k * Math.PI) * 0.06;
            pts.push(worldToPx(p.x, p.y, p.z));
        }
        return pts;
    };
    api.isBatCam = function () { return !!S.nearBat; };
    api.isAimCam = function () { return !!(S.nearBat || S.nearPitch); };
    api.aimBox = function () { return BOX[aimMode]; };
    api.aimMode = function () { return aimMode; };
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
        setFlagTeam(info.homeTeam);
        drawScoreboard(info.hud || G, info);
        // batter hides once he becomes a runner
        const hide = G.phase === info.PH.HR_RUN || (G.phase === info.PH.RESULT && ['OUT', 'HIT', '2 BASE HIT', '3 BASE HIT', 'WALK', 'HOMERUN'].includes(G.resSub));
        actors.batterWrap.visible = !hide;
        if (G.phase === info.PH.INNING_START || (!G.ballActive && G.phase !== info.PH.RESULT)) { S.flight = null; }
        updateFlight(G, info, dt);
        updatePitcher(G, info, df);
        updateCatcher(G, info, dt);
        updateUmpire(G, info);
        updateBatter(G, info, dt, df);
        updateFielders(G, info, dt, df);
        updateRunners(G, info, dt, df);
        S.prevScore = G.score.slice();
        updateBall(G, info, dt, df);
        stealActors(G, info, dt, df);
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
        renderVideoBoard(info);
        renderer.render(scene, camera);
    };

    // second camera on the mound looking at the batter, drawn into the video board texture
    function renderVideoBoard(info) {
        if (!vidRT || (vidTick++ & 1)) return;
        const bp = actors.batter.root.getWorldPosition(v1);
        vidCam.position.set(0.35, 1.62, MOUND_Z + 1.2);
        vidCam.lookAt(bp.x * 0.85, 1.05, 0); vidCam.updateMatrixWorld(true);
        const hid = [actors.catcher.root, actors.umpire.root], was = hid.map(o => o.visible);
        hid.forEach(o => o.visible = true); actors.pitcher.root.visible = false; mitt.visible = false; videoPlane.visible = false;
        renderer.setRenderTarget(vidRT); renderer.render(scene, vidCam); renderer.setRenderTarget(null);
        hid.forEach((o, i) => o.visible = was[i]); actors.pitcher.root.visible = true; videoPlane.visible = true; mitt.visible = was[0] === false;
    }

    return api;
})();
