import { _decorator, Component, Node, Vec3, Quat, Color, Label, tween, Tween } from 'cc';
import { BobbinWallChild } from './BobbinWallChild';
import { BobbinWallBorder } from './BobbinWallBorder';
import { MapObjectSpawner } from './MapObjectSpawner';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity BobbinWall.cs.
 *
 * Thay thế một yarn bằng một mảng HCN các BobbinWallChild.
 * areaX = số hàng đi xuống, areaY = số cột đi sang phải.
 * Bobbin cùng material bay qua sẽ trừ HP — hết HP wall splash + release.
 */
@ccclass('BobbinWall')
export class BobbinWall extends Component {

    /** Anchor node — Setup dời về top-left của grid để các child trải đều. */
    @property(Node) public center: Node = null;
    /** Label hiển thị HP runtime. */
    @property(Label) public scoreText: Label = null;

    public material: number = 0;

    /** Pivot offset của prefab BobbinWallGoc khi rotation = 0°. Đo bằng đơn vị world local của center.
     *  Code sẽ rotate offset theo từng góc xoay để bù trừ → góc luôn align với cạnh wall.
     *  Default `(-0.0075, 0, -0.0075)` đã calibrate cho prefab hiện tại — chỉnh lại nếu thay prefab. */
    @property public gocPivotOffset: Vec3 = new Vec3(-0.0075, 0, -0.0075);

    private _score: number = 0;
    public get score(): number { return this._score; }
    public set score(v: number) {
        this._score = v;
        if (this.scoreText) this.scoreText.string = v.toString();
    }

    private _children: BobbinWallChild[] = [];
    private _borderGocs: BobbinWallBorder[] = [];
    private _borderCanhs: BobbinWallBorder[] = [];

    // Splash settings — port từ Unity [Header("Splash Settings")]
    @property public splashDuration: number = 0.35;
    @property public splashMinHeight: number = 0.25;
    @property public splashMaxHeight: number = 0.7;
    @property public splashSpread: number = 0.4;

    // ─── Setup ────────────────────────────────────────────────────────────────────

    /** Spawn grid areaX × areaY child + borders. Gọi sau khi đã set `material` và `score`.
     *  Layout Cocos-native (KHÔNG 1:1 Unity X): vì BoardScaler không flip X như Unity,
     *  row tăng → world.x tăng (cùng chiều pixel.x). Z giữ nguyên giống Unity. */
    public setup(areaX: number, areaY: number, cellSize: number, color: Color): void {
        if (this.scoreText) {
            // Port Unity: scoreText.fontSize = Mathf.Clamp(6.3 * Math.min(areaX, areaY), 9, 20)
            // Cocos: nhân thêm 10 để phù hợp với scale runtime của Label trong scene Cocos.
            const fs = Math.max(9, Math.min(20, 6.3 * Math.min(areaX, areaY))) * 10;
            this.scoreText.fontSize = fs;
        }

        const halfX = (areaX - 1) / 2 * cellSize;
        const halfZ = (areaY - 1) / 2 * cellSize;

        // Cocos: child(0,0)_local = (-halfX, 0, -halfZ). Để child(0,0)_world = wall.position
        // (= pixel(px,py) world), center cần offset (+halfX, 0, +halfZ) — Unity dùng (-halfX, 0, +halfZ).
        if (this.center) this.center.setPosition(halfX, 0, halfZ);
        const childParent = this.center ?? this.node;

        const grid: (BobbinWallChild | null)[][] = [];
        for (let i = 0; i < areaX; i++) grid.push(new Array(areaY).fill(null));

        const spawner = MapObjectSpawner.instance;
        for (let row = 0; row < areaX; row++) {
            for (let col = 0; col < areaY; col++) {
                const child = spawner.getBobbinWallChild(childParent);
                if (!child) continue;
                // Cocos: row→+X, col→+Z (Unity dùng row→-X, col→+Z)
                child.node.setPosition(row * cellSize - halfX, 0, col * cellSize - halfZ);
                child.node.setRotation(Quat.IDENTITY);
                child.node.setScale(Vec3.ONE);
                this._children.push(child);
                if (child.meshRenderer) {
                    const mat = child.meshRenderer.getMaterialInstance(0);
                    if (mat) mat.setProperty('albedoColor', color);
                }
                grid[row][col] = child;
            }
        }

        this._spawnBorders(grid, areaX, areaY, cellSize, halfX, halfZ, childParent);
    }

    private _spawnBorders(
        grid: (BobbinWallChild | null)[][],
        areaX: number,
        areaY: number,
        cellSize: number,
        halfX: number,
        halfZ: number,
        parent: Node,
    ): void {
        const spawner = MapObjectSpawner.instance;
        const half = cellSize / 2;

        // Position TRỰC TIẾP trong local space của `center` (parent của tất cả child/border).
        // Không phụ thuộc anchor node trong prefab — engine-independent + không bị ảnh hưởng
        // bởi cellSize prefab khác cellSize runtime.
        // Tọa độ Cocos (row→+X, col→+Z): cell(row, col) local center = (row*cs - halfX, 0, col*cs - halfZ).
        // Wall outer 4 góc trong local center:
        //   BL: (-halfX - half, 0, -halfZ - half)   ← cell(0,0) outer
        //   BR: (+halfX + half, 0, -halfZ - half)   ← cell(X-1, 0) outer
        //   TL: (-halfX - half, 0, +halfZ + half)   ← cell(0, Y-1) outer
        //   TR: (+halfX + half, 0, +halfZ + half)   ← cell(X-1, Y-1) outer

        const placeGoc = (lx: number, lz: number, rotY: number): BobbinWallBorder | null => {
            const b = spawner.getBobbinWallGoc(parent);
            if (!b) return null;
            // Bù trừ pivot offset: pivot lệch khỏi geometric center → khi rotate, mesh dịch theo
            // đường tròn quanh pivot. Tính R(rotY) * gocPivotOffset rồi trừ vào target position
            // để mesh visual luôn ở đúng outer corner của wall.
            const rad = rotY * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const dx = this.gocPivotOffset.x, dz = this.gocPivotOffset.z;
            const offX = cos * dx + sin * dz;
            const offZ = -sin * dx + cos * dz;
            b.node.setPosition(lx - offX, 0, lz - offZ);
            const q = new Quat();
            Quat.fromEuler(q, 0, rotY, 0);
            b.node.setRotation(q);
            this._borderGocs.push(b);
            return b;
        };

        const placeCanh = (lx: number, lz: number, rotY: number): BobbinWallBorder | null => {
            const b = spawner.getBobbinWallCanh(parent);
            if (!b) return null;
            b.node.setPosition(lx, 0, lz);
            const q = new Quat();
            Quat.fromEuler(q, 0, rotY, 0);
            b.node.setRotation(q);
            this._borderCanhs.push(b);
            return b;
        };

        // 4 góc. Prefab Cocos `BobbinWallGoc` có default orientation lệch -90° so với Unity
        // (do FBX axis convert hoặc design khác) → trừ 90° từ rotation Unity:
        //   BL (-X, -Z): Unity +90 → Cocos 0
        //   BR (+X, -Z): Unity   0 → Cocos -90
        //   TL (-X, +Z): Unity +180 → Cocos +90
        //   TR (+X, +Z): Unity  -90 → Cocos -180
        if (grid[0][0])                       placeGoc(-halfX - half, -halfZ - half, 0);
        if (grid[areaX - 1][0])               placeGoc(+halfX + half, -halfZ - half, -90);
        if (grid[0][areaY - 1])               placeGoc(-halfX - half, +halfZ + half, 90);
        if (grid[areaX - 1][areaY - 1])       placeGoc(+halfX + half, +halfZ + half, -180);

        // Cạnh trên (row=0, -X side trong Cocos): canh nằm giữa col và col+1 ở row=0,
        // nhô ra phía -X (outer). Local: (-halfX - half, 0, (col + 0.5)*cs - halfZ).
        // Unity dùng rot=0 cho top edge; Cocos cũng rot=0 vì wall đối xứng theo trục Z khi mirror X.
        for (let col = 0; col < areaY - 1; col++) {
            if (!grid[0][col] || !grid[0][col + 1]) continue;
            const lz = (col + 0.5) * cellSize - halfZ;
            placeCanh(-halfX - half, lz, 0);
        }

        // Cạnh dưới (row=areaX-1, +X side): outer ở +X.
        for (let col = 0; col < areaY - 1; col++) {
            if (!grid[areaX - 1][col] || !grid[areaX - 1][col + 1]) continue;
            const lz = (col + 0.5) * cellSize - halfZ;
            placeCanh(+halfX + half, lz, 0);
        }

        // Cạnh trái (col=0, -Z side): canh nằm giữa row và row+1 ở col=0, nhô ra phía -Z.
        // Unity dùng rot=+90 cho side edges → Cocos cũng +90.
        for (let row = 0; row < areaX - 1; row++) {
            if (!grid[row][0] || !grid[row + 1][0]) continue;
            const lx = (row + 0.5) * cellSize - halfX;
            placeCanh(lx, -halfZ - half, 90);
        }

        // Cạnh phải (col=areaY-1, +Z side): outer ở +Z.
        for (let row = 0; row < areaX - 1; row++) {
            if (!grid[row][areaY - 1] || !grid[row + 1][areaY - 1]) continue;
            const lx = (row + 0.5) * cellSize - halfX;
            placeCanh(lx, +halfZ + half, 90);
        }
    }

    // ─── Punch (feedback khi trúng nhưng chưa vỡ) ─────────────────────────────────

    /** Port từ Unity DOPunchScale(Vec.one * 0.05, 0.1, 1, 0.1).
     *  Phồng lên rồi co lại nhẹ. Bỏ qua nếu đang punch. */
    private _isPunching: boolean = false;
    public punch(): void {
        if (this._isPunching) return;
        this._isPunching = true;
        const baseScale = this.node.scale.clone();
        const peak = new Vec3(baseScale.x + 0.05, baseScale.y + 0.05, baseScale.z + 0.05);
        tween(this.node)
            .to(0.05, { scale: peak })
            .to(0.05, { scale: baseScale })
            .call(() => { this._isPunching = false; })
            .start();
    }

    // ─── Splash + release khi HP = 0 ─────────────────────────────────────────────

    /** Bắn các child ra vòng cung mọi hướng, scale shrink, rồi gọi onComplete.
     *  Border (4 góc + cạnh) được release ngay ở đầu — không splash. */
    public splashAndRelease(onComplete: () => void): void {
        Tween.stopAllByTarget(this.node);
        if (this.scoreText) this.scoreText.node.active = false;

        const spawner = MapObjectSpawner.instance;
        for (const b of this._borderGocs) spawner.releaseBobbinWallGoc(b);
        for (const b of this._borderCanhs) spawner.releaseBobbinWallCanh(b);
        this._borderGocs = [];
        this._borderCanhs = [];

        const count = this._children.length;
        const froms: Vec3[] = new Array(count);
        const tos: Vec3[] = new Array(count);
        const heights: number[] = new Array(count);
        for (let i = 0; i < count; i++) {
            froms[i] = this._children[i].node.worldPosition.clone();
            const angle = Math.random() * Math.PI * 2;
            const dist = 0.08 + Math.random() * (this.splashSpread - 0.08);
            tos[i] = new Vec3(
                froms[i].x + Math.cos(angle) * dist,
                froms[i].y,
                froms[i].z + Math.sin(angle) * dist,
            );
            heights[i] = this.splashMinHeight + Math.random() * (this.splashMaxHeight - this.splashMinHeight);
        }

        const ctx = { t: 0 };
        const tmpPos = new Vec3();
        const scaleVec = new Vec3();
        tween(ctx)
            .to(this.splashDuration, { t: 1 }, {
                onUpdate: () => {
                    const pct = Math.max(0, Math.min(1, ctx.t));
                    const sinv = Math.sin(Math.PI * pct);
                    const s = 1 - pct;
                    scaleVec.set(s, s, s);
                    for (let i = 0; i < count; i++) {
                        const c = this._children[i];
                        if (!c?.node?.isValid) continue;
                        Vec3.lerp(tmpPos, froms[i], tos[i], pct);
                        tmpPos.y += heights[i] * sinv;
                        c.node.setWorldPosition(tmpPos);
                        c.node.setScale(scaleVec);
                    }
                }
            })
            .call(() => {
                for (let i = 0; i < count; i++) {
                    const c = this._children[i];
                    if (c?.node?.isValid) c.node.setScale(Vec3.ZERO);
                }
                onComplete?.();
            })
            .start();
    }

    // ─── Pool Reset ───────────────────────────────────────────────────────────────

    public resetForPool(): void {
        Tween.stopAllByTarget(this.node);
        this.unscheduleAllCallbacks();
        this.node.setScale(Vec3.ONE);
        if (this.scoreText) this.scoreText.node.active = true;

        const spawner = MapObjectSpawner.instance;
        for (const c of this._children) spawner.releaseBobbinWallChild(c);
        this._children = [];
        for (const b of this._borderGocs) spawner.releaseBobbinWallGoc(b);
        for (const b of this._borderCanhs) spawner.releaseBobbinWallCanh(b);
        this._borderGocs = [];
        this._borderCanhs = [];

        this._isPunching = false;
        this._score = 0;
        this.material = 0;
    }
}
