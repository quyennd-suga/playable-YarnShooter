import {
    _decorator, Component, Node, Vec3, Quat, Prefab, instantiate, tween, Tween,
} from 'cc';
import { GridPointData } from './Data/LevelInterfaces';
const { ccclass, property } = _decorator;

/**
 * Port từ Unity SnakeRetract.cs — adapted cho Cocos.
 *
 * KHÁC Unity: KHÔNG dùng Dreamteck Splines + TubeGenerator (Unity asset).
 * THAY THẾ: 2 pre-baked mesh (straight + corner) instantiate tại mỗi spine point.
 *  - straight mesh: hướng +Z mặc định, scale = cellSize
 *  - corner mesh: arm1=-Z (incoming), arm2=+X (outgoing) mặc định
 * Per-point chọn mesh + rotate/mirror dựa trên direction incoming/outgoing.
 *
 * Snake không có đuôi visual riêng — TailHole chính là điểm đuôi (thân chui ra từ hole).
 *
 * Flow:
 *  1. setupShape(...) — build spine qua morphological erosion + remove diagonals
 *     → instantiate body meshes per spine point + position Head/TailHole + snake items.
 *  2. tick() — score-- + lerp clipProgress → body meshes visible từ tail tới index
 *     ceil(clipProgress * N). Head di chuyển tới spine.evaluate(clipProgress).
 *  3. Khi score=0 → shrink TailHole + onComplete (caller release Snake về pool).
 *  4. projectOnSpline(worldPos) — chiếu vuông góc một điểm world lên spine.
 */
@ccclass('SnakeRetract')
export class SnakeRetract extends Component {
    @property(Node) public head: Node = null;
    /** Hố đuôi — vừa là điểm thân rắn chui ra, vừa là "đuôi" visual. */
    @property(Node) public tailHole: Node = null;
    /** Parent node chứa body mesh nodes. */
    @property(Node) public bodyParent: Node = null;
    /** Prefab thân thẳng — mặc định hướng dọc +Z, scale 1 ứng với 1 cell. */
    @property(Prefab) public bodyStraightPrefab: Prefab = null;
    /** Prefab khúc cong — mặc định arm1=-Z (incoming), arm2=+X (outgoing). */
    @property(Prefab) public bodyCornerPrefab: Prefab = null;
    /** Parent node chứa snake items (collider trigger). */
    @property(Node) public itemParent: Node = null;
    /** Prefab 1 collider trigger item, rải tại mỗi pixel body+tail. */
    @property(Prefab) public snakeItemPrefab: Prefab = null;

    @property public tickDuration: number = 0.3;
    @property public shrinkDuration: number = 0.3;
    /** Y offset cho spine points (giúp body nổi trên above layer). */
    @property public spineYOffset: number = 0.05;

    public score: number = 0;
    /** Callback khi snake hoàn thành (sau ShrinkHeadTail). Caller wire vào releaseSnake. */
    public onComplete: (() => void) | null = null;

    private _spinePoints: Vec3[] = [];
    private _cumLengths: number[] = [];
    private _totalLength: number = 0;
    private _bodyMeshes: Node[] = [];
    private _snakeItems: Node[] = [];
    private _clipProgress: number = 1;
    private _initialScore: number = 0;
    private _tickCtx: any = null;
    private _shrinkCtx: any = null;
    private _tailHoleOriginalScale: Vec3 = new Vec3(1, 1, 1);

    onLoad() {
        if (this.tailHole) this._tailHoleOriginalScale.set(this.tailHole.scale);
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /** Setup snake từ body + tail pixel arrays. originWorld = vị trí gốc (aboveParent worldPos).
     *  parentScale = aboveParent.scale.x để compensate khi BoardScaler scale map. */
    public setupShape(
        body: GridPointData[],
        tail: GridPointData[],
        cellSize: number,
        centerX: number,
        centerY: number,
        originWorld: Vec3,
        parentScale: number,
    ): void {
        if (body.length === 0) return;

        const widthSnake = Math.max(1, Math.round(Math.sqrt(tail.length)));

        const bodySet = new Set<string>();
        for (const p of body) bodySet.add(`${p.x},${p.y}`);
        for (const p of tail) bodySet.add(`${p.x},${p.y}`);

        // 1. Build spine via morphological erosion
        const spine = SnakeRetract._buildSpine(
            body, tail, bodySet, widthSnake, originWorld, cellSize, centerX, centerY, parentScale, this.spineYOffset,
        );
        if (spine.length < 2) return;

        // 2. Remove diagonal points (giữ Manhattan path)
        const cleaned = SnakeRetract._removeDiagonalPoints(spine, cellSize * 0.5 * parentScale);
        if (cleaned.length < 2) return;

        // 3. Push spawn point at front với Y elevated (head animation start)
        cleaned.unshift(new Vec3(cleaned[0].x, 0.35 * parentScale, cleaned[0].z));

        this._spinePoints = cleaned;
        this._computeCumLengths();

        // 4. Position Head (head terminus) + TailHole (ground tail end = spine[1], skip elevated spawn)
        if (this.head) this.head.setWorldPosition(this._spinePoints[this._spinePoints.length - 1]);
        if (this.tailHole) {
            const tailGround = this._spinePoints.length > 1 ? this._spinePoints[1] : this._spinePoints[0];
            this.tailHole.setWorldPosition(tailGround);
            this.tailHole.setScale(this._tailHoleOriginalScale);
        }

        // 5. Build body meshes + snake items
        this._buildBodyMeshes(parentScale, cellSize);
        this._buildSnakeItems(body, tail, cellSize, centerX, centerY, originWorld, parentScale);

        // 6. Reset clip state
        this._clipProgress = 1;
        this._initialScore = this.score;
        this._updateClipVisual();
    }

    /** Trừ HP + lerp body retract animation. Khi score=0 → shrink + onComplete. */
    public tick(): void {
        if (this._initialScore <= 0) return;
        this.score--;

        const minClip = this._spinePoints.length > 1 ? 1 / (this._spinePoints.length - 1) : 0;
        const target = Math.max(this.score / this._initialScore, minClip);
        const isDone = this.score <= 0;
        this._animateTick(this._clipProgress, target, isDone);
    }

    /** Chiếu worldPos vuông góc lên spine → trả world position của điểm gần nhất trên spine. */
    public projectOnSpline(worldPos: Vec3): Vec3 {
        if (this._spinePoints.length === 0) return worldPos.clone();
        if (this._spinePoints.length === 1) return this._spinePoints[0].clone();

        let bestX = this._spinePoints[0].x;
        let bestY = this._spinePoints[0].y;
        let bestZ = this._spinePoints[0].z;
        let bestDistSq = Vec3.squaredDistance(worldPos, this._spinePoints[0]);

        for (let i = 0; i < this._spinePoints.length - 1; i++) {
            const a = this._spinePoints[i];
            const b = this._spinePoints[i + 1];
            const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
            const ablen2 = abx*abx + aby*aby + abz*abz;
            if (ablen2 < 1e-10) continue;
            const apx = worldPos.x - a.x, apy = worldPos.y - a.y, apz = worldPos.z - a.z;
            let t = (apx*abx + apy*aby + apz*abz) / ablen2;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + abx*t, py = a.y + aby*t, pz = a.z + abz*t;
            const dx = worldPos.x - px, dy = worldPos.y - py, dz = worldPos.z - pz;
            const distSq = dx*dx + dy*dy + dz*dz;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestX = px; bestY = py; bestZ = pz;
            }
        }
        return new Vec3(bestX, bestY, bestZ);
    }

    public resetForPool(): void {
        if (this._tickCtx) { Tween.stopAllByTarget(this._tickCtx); this._tickCtx = null; }
        if (this._shrinkCtx) { Tween.stopAllByTarget(this._shrinkCtx); this._shrinkCtx = null; }
        Tween.stopAllByTarget(this.node);
        if (this.tailHole) Tween.stopAllByTarget(this.tailHole);
        this.unscheduleAllCallbacks();
        this._clearBodyMeshes();
        this._clearSnakeItems();
        this._spinePoints = [];
        this._cumLengths = [];
        this._totalLength = 0;
        this._clipProgress = 1;
        this._initialScore = 0;
        this.score = 0;
        if (this.head) this.head.active = true;
        if (this.tailHole) this.tailHole.setScale(this._tailHoleOriginalScale);
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(1, 1, 1);
    }

    // ─── Internal — Spine math ─────────────────────────────────────────────────

    /** Morphological erosion: pixel (px,py) là spine point nếu khối w×w bắt đầu từ (px,py)
     *  nằm HOÀN TOÀN trong bodySet. Centroid khối = world position của spine point. */
    private static _buildSpine(
        body: GridPointData[],
        tail: GridPointData[],
        bodySet: Set<string>,
        w: number,
        origin: Vec3,
        cellSize: number,
        centerX: number,
        centerY: number,
        parentScale: number,
        yOffset: number,
    ): Vec3[] {
        const spine: Vec3[] = [];
        const added = new Set<string>();

        const tryAdd = (px: number, py: number): void => {
            const key = `${px},${py}`;
            if (added.has(key)) return;
            added.add(key);

            for (let dx = 0; dx < w; dx++) {
                for (let dy = 0; dy < w; dy++) {
                    if (!bodySet.has(`${px + dx},${py + dy}`)) return;
                }
            }

            const cx = px + (w - 1) * 0.5;
            const cy = py + (w - 1) * 0.5;
            // Cocos: KHÔNG flip X (Unity flip; BoardScaler không flip)
            spine.push(new Vec3(
                origin.x + (cx - centerX) * cellSize * parentScale,
                origin.y + yOffset * parentScale,
                origin.z + (cy - centerY) * cellSize * parentScale,
            ));
        };

        for (const p of tail) tryAdd(p.x, p.y);
        for (const p of body) tryAdd(p.x, p.y);
        return spine;
    }

    private static _removeDiagonalPoints(pts: Vec3[], tol: number): Vec3[] {
        if (pts.length <= 2) return pts;
        const isStraight = (a: Vec3, b: Vec3): boolean =>
            Math.abs(a.x - b.x) < tol || Math.abs(a.z - b.z) < tol;

        const result: Vec3[] = [pts[0]];
        for (let i = 1; i < pts.length - 1; i++) {
            const prev = result[result.length - 1];
            const curr = pts[i];
            const next = pts[i + 1];
            const prevCurrStraight = isStraight(prev, curr);
            const currNextStraight = isStraight(curr, next);
            const remove = prevCurrStraight !== currNextStraight;
            if (!remove) result.push(curr);
        }
        result.push(pts[pts.length - 1]);
        return result;
    }

    private _computeCumLengths(): void {
        this._cumLengths = new Array(this._spinePoints.length);
        this._cumLengths[0] = 0;
        for (let i = 1; i < this._spinePoints.length; i++) {
            this._cumLengths[i] = this._cumLengths[i - 1] + Vec3.distance(this._spinePoints[i - 1], this._spinePoints[i]);
        }
        this._totalLength = this._cumLengths[this._cumLengths.length - 1];
    }

    /** Vị trí trên spine theo percent (0=tail, 1=head) tính theo cumulative length. */
    private _evaluate(percent: number, out?: Vec3): Vec3 {
        const dst = out ?? new Vec3();
        if (this._spinePoints.length === 0) return dst;
        if (this._spinePoints.length === 1) { dst.set(this._spinePoints[0]); return dst; }
        percent = Math.max(0, Math.min(1, percent));
        const target = this._totalLength * percent;
        let lo = 0, hi = this._spinePoints.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (this._cumLengths[mid] <= target) lo = mid; else hi = mid;
        }
        const segLen = this._cumLengths[hi] - this._cumLengths[lo];
        const t = segLen > 0 ? (target - this._cumLengths[lo]) / segLen : 0;
        Vec3.lerp(dst, this._spinePoints[lo], this._spinePoints[hi], t);
        return dst;
    }

    // ─── Internal — Body mesh placement (straight + corner prefabs) ────────────

    /** Snap XZ vector to axis-aligned unit direction. */
    private static _snapDirXZ(from: Vec3, to: Vec3): { dx: number, dz: number } {
        const ax = to.x - from.x;
        const az = to.z - from.z;
        if (Math.abs(ax) > Math.abs(az)) return { dx: Math.sign(ax) || 0, dz: 0 };
        if (Math.abs(az) > 1e-6) return { dx: 0, dz: Math.sign(az) };
        return { dx: 0, dz: 0 };
    }

    /** Y rotation cho straight mesh (default oriented along +Z) hướng theo `out` direction. */
    private static _straightRotY(out: { dx: number, dz: number }): number {
        if (out.dx > 0) return 90;
        if (out.dx < 0) return -90;
        if (out.dz < 0) return 180;
        return 0;
    }

    /** Corner orient lookup. Default corner mesh: arm1=-Z (incoming side), arm2=+X (outgoing side).
     *  Cocos Y-rotation convention: +Z rot+90° → +X, +X rot+90° → -Z (right-handed, look down -Y). */
    private static _computeCornerOrient(
        inc: { dx: number, dz: number },
        out: { dx: number, dz: number },
    ): { rotY: number, mirrorX: boolean, mirrorZ: boolean } {
        const key = `${inc.dx},${inc.dz}->${out.dx},${out.dz}`;
        switch (key) {
            case '0,1->1,0':   return { rotY: 0,    mirrorX: false, mirrorZ: false };
            case '0,1->-1,0':  return { rotY: 0,    mirrorX: true,  mirrorZ: false };
            case '0,-1->1,0':  return { rotY: 180,  mirrorX: true,  mirrorZ: false };
            case '0,-1->-1,0': return { rotY: 180,  mirrorX: false, mirrorZ: false };
            case '1,0->0,1':   return { rotY: 90,   mirrorX: false, mirrorZ: true  };
            case '1,0->0,-1':  return { rotY: 90,   mirrorX: false, mirrorZ: false };
            case '-1,0->0,1':  return { rotY: -90,  mirrorX: false, mirrorZ: false };
            case '-1,0->0,-1': return { rotY: -90,  mirrorX: false, mirrorZ: true  };
            default:           return { rotY: 0,    mirrorX: false, mirrorZ: false };
        }
    }

    /** Place body meshes per ground spine point (skip i=0 spawn point và i=N-1 head terminus).
     *  Mỗi point: tính inc/out direction (axis-snapped) → chọn straight vs corner mesh. */
    private _buildBodyMeshes(parentScale: number, cellSize: number): void {
        this._clearBodyMeshes();
        if (!this.bodyParent || !this.bodyStraightPrefab || !this.bodyCornerPrefab) return;
        const N = this._spinePoints.length;
        if (N < 3) return; // cần ít nhất spawn + 1 body + head

        const meshScale = cellSize * parentScale;
        const q = new Quat();

        for (let i = 1; i < N - 1; i++) {
            // i=1: prev là spawn point (cùng XZ) — dùng out cho inc luôn để tránh zero-dir.
            const incFrom = i === 1 ? this._spinePoints[i] : this._spinePoints[i - 1];
            const incTo   = i === 1 ? this._spinePoints[i + 1] : this._spinePoints[i];
            const inc = SnakeRetract._snapDirXZ(incFrom, incTo);
            const out = SnakeRetract._snapDirXZ(this._spinePoints[i], this._spinePoints[i + 1]);
            if ((inc.dx === 0 && inc.dz === 0) || (out.dx === 0 && out.dz === 0)) continue;

            const isStraight = inc.dx === out.dx && inc.dz === out.dz;
            const prefab = isStraight ? this.bodyStraightPrefab : this.bodyCornerPrefab;
            const node = instantiate(prefab);
            node.setParent(this.bodyParent);
            node.setWorldPosition(this._spinePoints[i]);

            let rotY: number;
            let mirrorX = false, mirrorZ = false;
            if (isStraight) {
                rotY = SnakeRetract._straightRotY(out);
            } else {
                const o = SnakeRetract._computeCornerOrient(inc, out);
                rotY = o.rotY; mirrorX = o.mirrorX; mirrorZ = o.mirrorZ;
            }

            Quat.fromEuler(q, 0, rotY, 0);
            node.setRotation(q);
            node.setScale(
                meshScale * (mirrorX ? -1 : 1),
                meshScale,
                meshScale * (mirrorZ ? -1 : 1),
            );

            this._bodyMeshes.push(node);
        }
    }

    private _clearBodyMeshes(): void {
        for (const m of this._bodyMeshes) {
            if (m?.isValid) m.destroy();
        }
        this._bodyMeshes = [];
    }

    /** Rải SnakeItem (collider trigger) tại từng pixel body+tail. */
    private _buildSnakeItems(
        body: GridPointData[],
        tail: GridPointData[],
        cellSize: number,
        centerX: number,
        centerY: number,
        origin: Vec3,
        parentScale: number,
    ): void {
        this._clearSnakeItems();
        if (!this.snakeItemPrefab || !this.itemParent) return;

        const spawnAt = (px: number, py: number): void => {
            const item = instantiate(this.snakeItemPrefab);
            item.setParent(this.itemParent);
            item.setWorldPosition(
                origin.x + (px - centerX) * cellSize * parentScale,
                origin.y,
                origin.z + (py - centerY) * cellSize * parentScale,
            );
            item.setScale(1, 1, 1);
            this._snakeItems.push(item);
        };

        for (const p of body) spawnAt(p.x, p.y);
        for (const p of tail) spawnAt(p.x, p.y);
    }

    private _clearSnakeItems(): void {
        for (const item of this._snakeItems) {
            if (item?.isValid) item.destroy();
        }
        this._snakeItems = [];
    }

    // ─── Internal — Tick + Shrink animation ────────────────────────────────────

    private _animateTick(from: number, to: number, isDone: boolean): void {
        if (this._tickCtx) Tween.stopAllByTarget(this._tickCtx);
        const ctx = { t: 0 };
        this._tickCtx = ctx;

        tween(ctx)
            .to(this.tickDuration, { t: 1 }, {
                onUpdate: () => {
                    if (!this.node?.isValid || !this._tickCtx) return;
                    const t = Math.max(0, Math.min(1, ctx.t));
                    const smooth = t * t * (3 - 2 * t);
                    this._clipProgress = from + (to - from) * smooth;
                    this._updateClipVisual();
                }
            })
            .call(() => {
                if (!this.node?.isValid) return;
                this._clipProgress = to;
                this._updateClipVisual();
                if (this._tickCtx === ctx) this._tickCtx = null;
                if (isDone) this._shrinkHeadTail();
            })
            .start();
    }

    /** Hide body meshes beyond ceil(clipProgress * N). Head position = evaluate(clipProgress). */
    private _updateClipVisual(): void {
        const M = this._bodyMeshes.length;
        if (M > 0) {
            // visible: từ index 0 (gần tail) tới visibleCount-1
            const visibleCount = Math.max(0, Math.min(M, Math.ceil(this._clipProgress * M)));
            for (let i = 0; i < M; i++) {
                const node = this._bodyMeshes[i];
                if (!node?.isValid) continue;
                const shouldShow = i < visibleCount;
                if (node.active !== shouldShow) node.active = shouldShow;
            }
        }
        if (this.head && this._spinePoints.length > 0) {
            const headPos = this._evaluate(this._clipProgress);
            this.head.setWorldPosition(headPos);
        }
    }

    private _shrinkHeadTail(): void {
        if (this.head) this.head.active = false;
        if (!this.tailHole) {
            this.onComplete?.();
            return;
        }
        const startScale = this.tailHole.scale.clone();
        const ctx = { t: 0 };
        this._shrinkCtx = ctx;

        tween(ctx)
            .to(this.shrinkDuration, { t: 1 }, {
                onUpdate: () => {
                    if (!this.tailHole?.isValid || !this._shrinkCtx) return;
                    const t = Math.max(0, Math.min(1, ctx.t));
                    const smooth = t * t * (3 - 2 * t);
                    const s = 1 - smooth;
                    this.tailHole.setScale(startScale.x * s, startScale.y * s, startScale.z * s);
                }
            })
            .call(() => {
                if (this._shrinkCtx === ctx) this._shrinkCtx = null;
                if (this.tailHole?.isValid) this.tailHole.setScale(Vec3.ZERO);
                this.onComplete?.();
            })
            .start();
    }
}
