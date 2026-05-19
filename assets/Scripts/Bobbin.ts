import { _decorator, Component, MeshRenderer, Color, Material, Node, EventTouch, tween, Tween, Vec3, Label, Quat } from 'cc';
import { EventBus, GameEvents } from './Core/EventBus';
import { ShooterData } from './Data/LevelInterfaces';
import { MapObjectSpawner } from './MapObjectSpawner';
import { RopeSimulator } from './Core/RopeSimulator';
import { Connection } from './Core/Connection';
import { SplineManager } from './Core/SplineManager';
import { LevelManager } from './Core/LevelManager';
import { TrayManager } from './Core/TrayManager';
import { BobbinWall } from './BobbinWall';
import { Key } from './Key';
import { Barrier } from './Barrier';
const { ccclass, property } = _decorator;

@ccclass('Bobbin')
export class Bobbin extends Component {
    @property(MeshRenderer) public meshRenderer: MeshRenderer = null;
    /** Điểm bắn tia Raycast (giống Bobbin.shoot trong Unity).
     *  Nếu gán vào thì raycast bắt đầu từ đây, nếu không sẽ fallback về vị trí Tray. */
    @property(Node) public shoot: Node = null;

    /** Label số đạn khi bobbin trong queue row (nhìn từ trên xuống). */
    @property(Label) public score1: Label = null;
    /** Label số đạn khi bobbin ngồi trên tray ở belt (nhìn từ bên cạnh, cần xoay theo tray). */
    @property(Label) public score2: Label = null;
    /** Label số đạn mặc định khi bobbin chưa active. */
    @property(Label) public score3: Label = null;

    /** Node chứa mesh khi bobbin active (đầu hàng, sẵn sàng nhảy lên tray). */
    @property(Node) public activeVisual: Node = null;
    /** Node chứa mesh khi bobbin inactive (đứng sau hàng, chưa sẵn sàng — thường mờ hơn). */
    @property(Node) public inactiveVisual: Node = null;

    /** Node cha chứa các ring (mỗi child là 1 RopeBobbin). Active dần theo % ammo bị bắn. */
    @property(Node) public ropeCircle: Node = null;

    // ─── Mechanic Mystery (port 1:1 từ Unity Bobbin.cs) ────────────────────────
    /** Node hiển thị icon "?" (mystery cube) — bật khi bobbin là Mystery. */
    @property(Node) public mystery: Node = null;
    /** Material che màu thật của bobbin khi inactive (tương đương DataManager.HiddenShooterMaterial bên Unity). */
    @property(Material) public hiddenShooterMaterial: Material = null;

    // ─── Mechanic Connection (Linked Bobbin) ───────────────────────────────────
    /** Anchor cho rope cylinder của Connection (port 1:1 từ Unity Bobbin.center).
     *  Gán node "CenterConnection" trong prefab. */
    @property(Node) public center: Node = null;

    public isActive: boolean = false;
    public data: ShooterData = null;

    // Trạng thái vị trí — giống các flag _inQueueRow / _inOverflow bên Unity Bobbin
    public inQueueRow: boolean = false;  // đang trong grid queue (GridQueueManager)
    public inOverflow: boolean = false;  // đang trong overflow queue (OverflowQueue)

    // ─── Connection state (runtime, không expose Inspector) ────────────────────
    /** Connection chứa bobbin này (null nếu standalone). Gán bởi Connection.setup. */
    public connection: Connection = null;
    /** True khi bobbin đã bắt đầu checkout (đang bay/trên belt/đã hoàn thành). */
    public isCheckedOut: boolean = false;
    /** Score đã về 0 nhưng đang chờ các bobbin khác trong connection cùng xong. */
    public pendingConnectionComplete: boolean = false;
    /** Bobbin đang bay về queue nhưng connection đã hoàn thành — sẽ complete khi đáp xuống. */
    public markedForCompletion: boolean = false;
    /** Reference tới BobbinFrozen wrap quanh bobbin (set bởi MapGenerator.spawnFrozenShooters). */
    public frozenMechanic: Component = null;

    private _mat: Material = null;
    private _matInactive: Material = null; // Material instance của inactiveVisual (cùng material asset với mesh chính)
    private _originPos: Vec3 = new Vec3();
    private _score2WorldRotLock: Quat = null; // Capture lúc bobbin ngồi lên tray lần đầu
    private _initialScore: number = 0; // Ammo gốc khi spawn (dùng để tính tỉ lệ ring active)
    public currentColor: Color = new Color(255, 255, 255, 255);

    onLoad() {
        if (this.meshRenderer) {
            this._mat = this.meshRenderer.getMaterialInstance(0);
        }
        // Lấy material instance của inactiveVisual (dùng cùng material asset)
        if (this.inactiveVisual) {
            const mr = this.inactiveVisual.getComponent(MeshRenderer)
                ?? this.inactiveVisual.getComponentInChildren(MeshRenderer);
            if (mr) this._matInactive = mr.getMaterialInstance(0);
        }
        // Initial label states cho fresh-instantiated bobbin (không qua pool resetState):
        //   score3 ON (default visible từ trước/dưới), score1/2 OFF, mystery OFF.
        // Match Unity ResetForPool initial pattern. setActiveState/setMystery sẽ override sau.
        if (this.score1) this.score1.node.active = false;
        if (this.score2) this.score2.node.active = false;
        if (this.score3) this.score3.node.active = true;
        if (this.mystery) this.mystery.active = false;
    }

    start() {
        this._originPos.set(this.node.position);
    }


    public setColor(color: Color): void {
        this.currentColor.set(color);
        if (this._mat) {
            this._mat.setProperty('albedoColor', color);
        }
        // inactiveVisual cùng material → áp dụng cùng cách
        if (this._matInactive) {
            this._matInactive.setProperty('albedoColor', color);
        }
        // Cập nhật màu cho các ring trên ropeCircle (vân sọc giống rope trail)
        this._updateRopeRingColors(color);
    }

    /** Đổi màu các ring trên ropeCircle dùng shader mk-toon-stripe.
     *  Dùng chung helper RopeSimulator.computeStripeColor để ring và rope trail luôn đồng bộ tone. */
    private _updateRopeRingColors(color: Color): void {
        if (!this.ropeCircle) return;
        const colorA = color;
        const colorB = RopeSimulator.computeStripeColor(color);

        for (let i = 0; i < this.ropeCircle.children.length; i++) {
            const ring = this.ropeCircle.children[i];
            const mr = ring.getComponent(MeshRenderer) ?? ring.getComponentInChildren(MeshRenderer);
            if (!mr) continue;
            const mat = mr.getMaterialInstance(0);
            if (!mat) continue;

            mat.setProperty('colorA', colorA);
            mat.setProperty('colorB', colorB);
        }
    }

    /** Bật/tắt visual active vs inactive (giống Unity SetBobbinState).
     *  Inactive chỉ áp dụng KHI bobbin đang ở grid queue và chưa ở đầu hàng.
     *  Khi bobbin ngoài grid queue (đang bay/ngồi tray/trên belt) → luôn activeVisual. */
    public setActiveState(active: boolean): void {
        const wasActive = this.isActive;
        this.isActive = active;

        if (this.inQueueRow) {
            // Trong grid queue: swap visual + label theo flag active
            if (this.activeVisual) this.activeVisual.active = active;
            if (this.inactiveVisual) this.inactiveVisual.active = !active;
            // Match Unity SetBobbinState: score1 toggle theo active, KHÔNG gate bởi mystery.
            // Mystery icon stays sticky — score1 + mystery có thể coexist (Unity behavior).
            if (this.score1) this.score1.node.active = active;
            if (this.score2) this.score2.node.active = false;
        } else {
            // Ngoài grid queue: luôn show activeVisual, không động vào score
            if (this.activeVisual) this.activeVisual.active = true;
            if (this.inactiveVisual) this.inactiveVisual.active = false;
        }

        // Port 1:1 từ Unity SetBobbinState:355 — khi đi vào inactive, dời center hơi xuống
        // để rope cylinder của Connection nối đúng phần body bobbin trong queue.
        // CHỈ áp dụng khi bobbin còn trong queue row; ngoài queue (bay/belt/overflow)
        // không được dời center nữa vì sẽ làm rope lệch khi cluster checkout.
        if (!active && this.center && this.inQueueRow) {
            this.center.setPosition(0, -0.1, 0);
        }

        // Refresh màu cylinder của connection khi member chuyển active/inactive
        // (port 1:1 từ Unity Bobbin.SetBobbinState — `if (connection != null) connection.RefreshColor(this);`)
        if (this.connection) {
            this.connection.refreshColor(this);
        }

        // Mystery reveal VFX — port 1:1 từ Unity Bobbin.SetBobbinState (nhánh isActive && mystery.activeSelf)
        if (active && !wasActive && this.mystery && this.mystery.active) {
            this._playMysteryRevealVfx();
        }
    }

    /** Coroutine ActiveVfx bên Unity: delay 0.15s rồi spawn FxBobbin tại vị trí bobbin (y + 0.275). */
    private _playMysteryRevealVfx(): void {
        this.scheduleOnce(() => {
            const spawner = MapObjectSpawner.instance;
            if (!spawner || !this.node || !this.node.isValid) return;
            const wp = this.node.worldPosition;
            spawner.spawnFxBobbin(new Vec3(wp.x, wp.y + 0.275, wp.z));
        }, 0.15);
    }

    /** Đánh dấu bobbin này là Mystery (port 1:1 từ Unity Bobbin.SetMystery).
     *  Mystery icon là "sticky" — không tự tắt khi bobbin trở thành head/belt; chỉ thay thế
     *  score3 mặc định + đổi material inactiveVisual. score1/2 vẫn toggle bình thường theo state. */
    public setMystery(): void {
        if (this.score3) this.score3.node.active = false;
        if (this.mystery) this.mystery.active = true;
        if (this.inactiveVisual && this.hiddenShooterMaterial) {
            const mr = this.inactiveVisual.getComponent(MeshRenderer)
                ?? this.inactiveVisual.getComponentInChildren(MeshRenderer);
            if (mr) mr.setSharedMaterial(this.hiddenShooterMaterial, 0);
        }
    }

    /** Init ammo lúc spawn — set cả _initialScore (dùng cho UpdateRings) và refresh label/ring. */
    public setScore(value: number): void {
        this._initialScore = value;
        this._refreshScoreLabels(value);
        this.updateRings();
    }

    /** Giảm ammo 1 đơn vị và refresh label + ring. KHÔNG đụng _initialScore. */
    public decrementAmmo(): void {
        if (!this.data) return;
        this.data.ammo--;
        this._refreshScoreLabels(this.data.ammo);
        this.updateRings();
    }

    private _refreshScoreLabels(value: number): void {
        const s = value.toString();
        if (this.score1) this.score1.string = s;
        if (this.score2) this.score2.string = s;
        if (this.score3) this.score3.string = s;
    }

    /** Cập nhật ring trên ropeCircle theo tỉ lệ score/_initialScore.
     *  Score càng giảm → càng nhiều ring active (giống Unity Bobbin.UpdateRings). */
    public updateRings(): void {
        if (!this.ropeCircle) return;
        const total = this.ropeCircle.children.length;
        const score = this.data?.ammo ?? 0;
        let active: number;
        if (this._initialScore <= 0 || score <= 0) {
            active = total;
        } else {
            active = total - Math.floor(score / this._initialScore * total);
        }
        for (let i = 0; i < total; i++) {
            this.ropeCircle.children[i].active = (i < active);
        }
    }

    /** Bật/tắt label phù hợp khi bobbin vào queue row (giống Unity SetInQueueRow). */
    public setInQueueRow(value: boolean): void {
        this.inQueueRow = value;
        if (value) {
            if (this.score1) this.score1.node.active = true;
            if (this.score2) this.score2.node.active = false;
        }
    }

    /** Gọi bởi SplineManager khi bobbin bắt đầu bay (checkout): ẩn score1 ngay. */
    public onCheckoutStart(): void {
        if (this.score1) this.score1.node.active = false;
    }

    /** Gọi bởi SplineManager khi bobbin ngồi lên tray: hiện score2. */
    public onPlacedOnBelt(): void {
        if (this.score2) {
            this.score2.node.active = true;
            // Capture world rotation CHỈ lần đầu lên tray, sau đó dùng lại pose đó mãi
            if (!this._score2WorldRotLock) {
                this._score2WorldRotLock = new Quat();
                this.score2.node.getWorldRotation(this._score2WorldRotLock);
            }
            // Apply rotation đã lock ngay từ frame đầu được active → score2 đúng góc
            // ngay cả khi đang ở staging (không nhờ keepScore2Upright trong updateMovers)
            this.score2.node.setWorldRotation(this._score2WorldRotLock);
        }
    }

    /** Mỗi frame khi trên belt: lock world rotation của score2 về pose đã capture
     *  → text giữ nguyên hướng dù tray xoay theo spline. */
    public keepScore2Upright(_tray: Node): void {
        if (!this.score2 || !this._score2WorldRotLock) return;
        this.score2.node.setWorldRotation(this._score2WorldRotLock);
    }

    public onClick() {
        if (this.isCheckedOut) { this.shake(); return; }
        if (!TrayManager.instance?.hasAvailableTray) { this.shake(); return; }

        // Connection (Linked Bobbin) — port 1:1 từ Unity Bobbin.OnClick (nhánh `if connection != null`).
        // Click bất kỳ member nào → CheckoutAll cả cluster.
        if (this.connection) {
            if (!this.connection.canCheckout()) { this.shake(); return; }
            this.connection.checkoutAll();
            return;
        }

        // Standalone bobbin: bắn sự kiện lên cho QueueManager/LevelManager quyết định
        EventBus.emit(GameEvents.ON_BOBBIN_CLICKED, this);
    }

    /** Port 1:1 từ Unity Bobbin.HandleBobbinWallHit.
     *  Trả về true nếu hit hợp lệ (material match + còn HP wall + còn ammo bobbin) → SplineManager
     *  sẽ setup rope/anchor. Trả về false nếu mismatch hoặc dead → raycast bị "block" tại wall.
     *  Damage logic: trừ 1 ammo bobbin + 1 HP wall, hết HP → splashAndRelease, chưa hết → punch. */
    public handleBobbinWallHit(wall: BobbinWall): boolean {
        if (!this.data || this.data.ammo <= 0) return false;
        if (!wall) return false;
        if (wall.material !== this.data.material) return false;
        if (wall.score <= 0) return false;

        // Match Unity: score-- trên bobbin (ammo) + wall.score-- (HP)
        this.decrementAmmo();
        wall.score = wall.score - 1;

        if (wall.score <= 0) {
            wall.splashAndRelease(() => {
                if (wall?.node?.isValid) MapObjectSpawner.instance.releaseBobbinWall(wall);
            });
        } else {
            wall.punch();
        }
        return true;
    }

    /** Port 1:1 từ Unity Bobbin.HandleBarrierHit.
     *  Trừ HP barrier (decrementScore lerp body shrink). Hết HP → barrier auto release pool.
     *  KHÔNG tự trừ ammo bobbin — Unity SplineManager.FireYarnRaycast làm điều đó tại nhánh
     *  `if (isMatch) mover.Bobbin.score--` sau khi handler trả true. Trong Cocos,
     *  SplineManager.handleBarrierRopeAndAnchor sẽ gọi decrementAmmo.
     *  Trả false nếu: bobbin hết ammo, mismatch material, hoặc barrier đã chết — raycast bị block. */
    public handleBarrierHit(barrier: Barrier): boolean {
        if (!this.data || this.data.ammo <= 0) return false;
        if (!barrier) return false;
        if (barrier.material !== this.data.material) return false;
        if (barrier.score <= 0) return false;

        // Unity: spinIndicator.Trigger() + UpdateRings — chưa port spinIndicator
        this.updateRings();
        barrier.decrementScore();
        return true;
    }

    /** Port 1:1 từ Unity Bobbin.HandleKeyHit.
     *  Khác BobbinWall/Yarn: KHÔNG trừ ammo, KHÔNG yêu cầu material match.
     *  Flow:
     *    1. Tìm Lock đầu hàng chưa reserved qua LevelManager.tryFindHeadLock()
     *    2. key.tryActivate(lockWorldPos, () => LevelManager.unlockRow(rowIdx))
     *       → key fly arc tới lockPos rồi gọi unlockRow.
     *    3. Trả false nếu key đã used hoặc không có lock nào → raycast bị block tại key. */
    public handleKeyHit(key: Key): boolean {
        if (!key) { console.log('[handleKeyHit] key null'); return false; }
        const headLock = LevelManager.instance?.tryFindHeadLock();
        if (!headLock) { console.log('[handleKeyHit] NO head lock found (lock không ở row[0] hoặc đã reserved)'); return false; }
        console.log('[handleKeyHit] found headLock rowIdx=', headLock.rowIdx, 'worldPos=', headLock.worldPos);
        if (!key.tryActivate(headLock.worldPos, () => {
            console.log('[handleKeyHit] onUnlocked callback fired → unlockRow', headLock.rowIdx);
            LevelManager.instance?.unlockRow(headLock.rowIdx);
        })) { console.log('[handleKeyHit] key.tryActivate FAILED (key đã used)'); return false; }
        console.log('[handleKeyHit] key activated, flying to lock...');
        return true;
    }

    /** Bobbin này có thể tham gia checkout trong connection không?
     *  True nếu đang ở đầu hàng, hoặc tất cả bobbin đứng trước trong hàng đều cùng connection.
     *  (Port 1:1 từ Unity Bobbin.IsEffectivelyActiveForConnection). */
    public isEffectivelyActiveForConnection(conn: Connection): boolean {
        if (this.isActive) return true;
        if (!this.inQueueRow) return false;
        return LevelManager.instance?.isBobbinEffectivelyActive(this, conn) ?? false;
    }

    public updateOriginPos() {
        this._originPos.set(this.node.position);
    }

    /** Reset toàn bộ runtime state về mặc định trước khi trả về pool.
     *  Port 1:1 từ Unity Bobbin.ResetState — bắt buộc gọi qua MapObjectSpawner.releaseBobbin
     *  để tránh state leak (connection/isCheckedOut/pendingConnectionComplete...) giữa các lần dùng. */
    public resetState(): void {
        Tween.stopAllByTarget(this.node);
        this.unscheduleAllCallbacks();

        // Flags
        this.isActive = false;
        this.inQueueRow = false;
        this.inOverflow = false;
        this.isCheckedOut = false;
        this.pendingConnectionComplete = false;
        this.markedForCompletion = false;
        this.connection = null;
        this.frozenMechanic = null;
        this.data = null;

        // Transform
        this.node.setScale(Vec3.ONE);
        this.node.setRotation(Quat.IDENTITY);

        // Visuals về trạng thái inactive default (giống Unity ResetState)
        if (this.activeVisual) this.activeVisual.active = false;
        if (this.inactiveVisual) this.inactiveVisual.active = true;
        if (this.score1) this.score1.node.active = false;
        if (this.score2) this.score2.node.active = false;
        if (this.score3) this.score3.node.active = true;
        if (this.mystery) this.mystery.active = false;

        // Tắt hết ring (giống Unity ResetState)
        if (this.ropeCircle) {
            for (let i = 0; i < this.ropeCircle.children.length; i++) {
                this.ropeCircle.children[i].active = false;
            }
        }

        // Score
        this._initialScore = 0;
        this._score2WorldRotLock = null;

        // Center về vị trí inactive (giống Unity ResetState:288)
        if (this.center) this.center.setPosition(0, -0.1, 0);
    }

    /** Port 1:1 từ Unity Bobbin.BeginSpawnFromPipe.
     *  Bobbin xuất hiện tại vị trí pipe (scale=0), nhảy tới targetWorld với easeIn cubic,
     *  scale lên 1. Trong animation collider bị tắt → không clickable. */
    public beginSpawnFromPipe(targetWorld: Vec3, duration: number = 0.45): void {
        const fromWorld = this.node.worldPosition.clone();
        const to = targetWorld.clone();

        Tween.stopAllByTarget(this.node);
        this.node.setScale(Vec3.ZERO);

        const ctx = { t: 0 };
        const tmp = new Vec3();

        tween(ctx)
            .to(duration, { t: 1 }, {
                onUpdate: () => {
                    if (!this.node?.isValid) return;
                    const t = Math.max(0, Math.min(1, ctx.t));
                    const easeIn = t * t * t; // EaseInCubic — chậm đầu, nhanh cuối
                    tmp.set(
                        fromWorld.x + (to.x - fromWorld.x) * easeIn,
                        fromWorld.y + (to.y - fromWorld.y) * easeIn,
                        fromWorld.z + (to.z - fromWorld.z) * easeIn,
                    );
                    this.node.setWorldPosition(tmp);
                    this.node.setScale(easeIn, easeIn, easeIn);
                }
            })
            .call(() => {
                if (!this.node?.isValid) return;
                this.node.setWorldPosition(to);
                this.node.setScale(1, 1, 1);
                this.updateOriginPos();
                // Unity: SpawnFxBobbin tại vị trí bobbin (y+0.275) — match _playMysteryRevealVfx pattern
                const spawner = MapObjectSpawner.instance;
                if (spawner) {
                    const wp = this.node.worldPosition;
                    spawner.spawnFxBobbin(new Vec3(wp.x, wp.y + 0.275, wp.z));
                }
            })
            .start();
    }

    public shake() {
        Tween.stopAllByTarget(this.node);
        this.node.setPosition(this._originPos); // reset về gốc trước khi rung
        tween(this.node)
            .by(0.05, { position: new Vec3(0.05, 0, 0) })
            .by(0.1, { position: new Vec3(-0.1, 0, 0) })
            .by(0.05, { position: new Vec3(0.05, 0, 0) })
            .call(() => {
                this.node.setPosition(this._originPos);
            })
            .start();
    }
}
