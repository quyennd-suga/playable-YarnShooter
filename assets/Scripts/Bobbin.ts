import { _decorator, Component, MeshRenderer, Color, Material, Node, EventTouch, tween, Tween, Vec3, Label, Quat } from 'cc';
import { EventBus, GameEvents } from './Core/EventBus';
import { ShooterData } from './Data/LevelInterfaces';
import { MapObjectSpawner } from './MapObjectSpawner';
import { RopeSimulator } from './Core/RopeSimulator';
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

    public isActive: boolean = false;
    public data: ShooterData = null;

    // Trạng thái vị trí — giống các flag _inQueueRow / _inOverflow bên Unity Bobbin
    public inQueueRow: boolean = false;  // đang trong grid queue (GridQueueManager)
    public inOverflow: boolean = false;  // đang trong overflow queue (OverflowQueue)

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
            if (this.score1) this.score1.node.active = active;
            if (this.score2) this.score2.node.active = false;
        } else {
            // Ngoài grid queue: luôn show activeVisual, không động vào score
            if (this.activeVisual) this.activeVisual.active = true;
            if (this.inactiveVisual) this.inactiveVisual.active = false;
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
     *  - Ẩn score3 (số đạn mặc định) để không lộ thông tin.
     *  - Bật node mystery (hiển thị icon "?").
     *  - Đổi material inactiveVisual sang HiddenShooterMaterial để che màu thật. */
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
        // Bắn sự kiện lên cho QueueManager quyết định xem có cho phép rút (checkout) không
        EventBus.emit(GameEvents.ON_BOBBIN_CLICKED, this);
    }

    public updateOriginPos() {
        this._originPos.set(this.node.position);
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
