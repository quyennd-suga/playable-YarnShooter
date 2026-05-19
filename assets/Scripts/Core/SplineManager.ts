import { _decorator, Component, Node, Vec3, tween, PhysicsSystem, geometry, Quat, Prefab, instantiate } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { Bobbin } from '../Bobbin';
import { Yarn } from '../Yarn';
import { QueueManager } from './QueueManager';
import { OverflowQueue } from './OverflowQueue';
import { RopeSimulator } from './RopeSimulator';
import { SplineCustom } from './SplineCustom';
import { TrayManager } from './TrayManager';
import { Tray } from '../Tray';
import { Connection } from './Connection';
import { MapObjectSpawner } from '../MapObjectSpawner';
import { BobbinWall } from '../BobbinWall';
import { BobbinWallChild } from '../BobbinWallChild';
import { Key } from '../Key';
import { Barrier } from '../Barrier';
import { BoardScaler } from '../BoardScaler';
import { GameManager } from './GameManager';

const { ccclass, property } = _decorator;

class TrayMover {
    public bobbin: Bobbin = null;
    public tray: Tray = null; // Xe Gòn chở Bobbin
    public progress: number = 0;
    public ropeReleaseTimer: number = 0;
    public currentSegIdx: number = -1;

    public hasAnchor: boolean = false;
    public nextFirePos: Vec3 = new Vec3();
    public activeRope: RopeSimulator = null;
    public lastSnapDir: Vec3 = new Vec3();
    public lastInward: Vec3 = new Vec3();

    public isFirstFrame: boolean = true;
    public steerRot: Quat = new Quat();
    public rollAngle: number = 0;
}

class PendingCheckout {
    public bobbin: Bobbin = null;
    public bobbinFlyDone: boolean = false;
    public tray: Tray = null;
    public trayArrived: boolean = false;

    // QueueTray staging (dùng khi belt không còn chỗ)
    public useQueueTray: boolean = false;
    public queueTraySlot: number = -1;
    public queueTrayTargetPos: Vec3 = new Vec3(); // vị trí staging (cao hơn startTray)
    public trayArrivedAtQueue: boolean = false;   // tray đến vị trí staging
    public readyForBelt: boolean = false;          // đã rơi xuống startTray, chờ vào belt

    // isFlying: còn đang bay đến đích (staging hay startTray)
    public get isFlying(): boolean {
        if (this.useQueueTray) return !this.bobbinFlyDone || !this.trayArrivedAtQueue;
        return !this.bobbinFlyDone || !this.trayArrived;
    }
}

@ccclass('SplineManager')
export class SplineManager extends Component {
    public static instance: SplineManager = null;

    @property(SplineCustom) public spline: SplineCustom = null;

    @property(Node) public startBobbin: Node = null;
    @property(Node) public startTray: Node = null;
    @property(Node) public yarnParent: Node = null;

    @property public maxTrays: number = 5;
    @property public turnSpeed: number = 15.0;
    @property public rollSpeed: number = 500.0;

    /** Euler offset của Tray khi chạy trên belt (chỉnh trong Inspector nếu bị lệch). */
    @property(Vec3) public trayBeltEuler: Vec3 = new Vec3(0, -90, 0);

    /** Điều chỉnh độ cao của Tray so với yần (dương = cao hơn, âm = thấp hơn).
     *  Chỉnh cho đến khi Bobbin ngồi trên Tray ngang bằng với Yarn là được. */
    @property public trayYOffset: number = 0;

    @property public queueTrayStartSpacing: number = 2.0;   // khoảng cách Y từ startBobbin lên slot đầu tiên
    @property public queueTrayBetweenSpacing: number = 1.5; // khoảng cách Y giữa các slot
    @property public queueTrayDropSpeed: number = 3.0;      // tốc độ rơi bình thường
    @property public queueTrayDropSpeedNearStart: number = 1.0; // tốc độ rơi khi gần startTray
    @property public queueTrayDropGapBetween: number = 0.3; // khoảng gap tối thiểu giữa 2 tray đang rơi
    @property public queueTraySlotCount: number = 3;        // số slot staging tối đa
    @property public bobbinFlyDuration: number = 0.4;
    @property public queueTrayMinScale: number = 0.7;
    @property public minSpacing: number = 1.5;

    @property public raycastDistance: number = 100.0;
    @property public flipRaycastSide: boolean = false;
    @property public raycastYOffset: number = 0.05;
    @property public ropeReleaseDelay: number = 0.08;
    @property(Prefab) public ropePrefab: Prefab = null;

    /** Tham chiếu aboveParent (cùng node mà MapGenerator dùng) — để scale raycastYOffset theo
     *  scale.y của parent khi ảnh pixel lớn làm yarn collider thu nhỏ. Nếu để trống thì offset
     *  dùng nguyên gốc (chấp nhận miss yarn ở các level có ảnh quá lớn). */
    @property(Node) public aboveParent: Node = null;

    /** Reference BoardScaler — dùng để lấy cellSize world (= boardScaler.cellSize * parentScale)
     *  cho nextFirePos offset. Port từ Unity `cellW = mapGenerator.cellSize`. */
    @property(BoardScaler) public boardScaler: BoardScaler = null;

    private _activeMovers: TrayMover[] = [];
    private _checkoutQueue: PendingCheckout[] = [];
    private _queueTrayOccupied: boolean[] = [];
    private _lastExpectedBeltEntryTime: number = 0;

    private _segLengths: number[] = [];
    private _segSnapDirs: Vec3[] = [];
    private _segInwards: Vec3[] = [];
    private _totalPathLength: number = 0;
    private _ray: geometry.Ray = new geometry.Ray();

    onLoad() {
        if (!SplineManager.instance) { SplineManager.instance = this; }
        else { this.node.destroy(); return; }

        EventBus.on(GameEvents.ON_BOBBIN_CHECKOUT, this.onBobbinCheckout, this);
    }

    start() {
        if (this.spline) {
            this.spline.rebuild();
        }
        this.rebuildSpline();
    }

    public rebuildSpline() {
        this._segLengths = [];
        this._segSnapDirs = [];
        this._segInwards = [];
        this._totalPathLength = 0;

        if (!this.spline || this.spline.wps.length < 2) return;

        let wps = this.spline.wps;

        for (let i = 0; i < wps.length - 1; i++) {
            let p1 = wps[i];
            let p2 = wps[i + 1];
            let fwd = new Vec3();
            Vec3.subtract(fwd, p2, p1);

            let len = fwd.length();
            this._segLengths.push(len);
            this._totalPathLength += len;

            let snapped = new Vec3();
            if (Math.abs(fwd.x) >= Math.abs(fwd.z)) {
                snapped = fwd.x >= 0 ? Vec3.UNIT_X.clone() : new Vec3(-1, 0, 0);
            } else {
                snapped = fwd.z >= 0 ? Vec3.UNIT_Z.clone() : new Vec3(0, 0, -1);
            }
            this._segSnapDirs.push(snapped);

            let inward = new Vec3();
            Vec3.cross(inward, snapped, Vec3.UNIT_Y);
            inward.normalize();

            if (this.flipRaycastSide) {
                inward.multiplyScalar(-1);
            }

            this._segInwards.push(inward);
        }
    }

    public hasAvailableSlot(): boolean {
        if (!TrayManager.instance?.hasAvailableTray) return false;
        // Cho phép nếu belt còn chỗ HOẶC còn slot staging (QueueTray)
        return this._hasBeltSpacing() || this._findFreeQueueTraySlot() >= 0;
    }

    /** Số slot còn lại cho checkout (port 1:1 từ Unity SplineManager.AvailableSlots).
     *  Connection.canCheckout dùng để check belt đủ chỗ cho cả cluster. */
    public get availableSlots(): number {
        return this.maxTrays - (this._activeMovers.length + this._checkoutQueue.length);
    }

    /** Port 1:1 từ Unity SplineManager.ForceReleaseSingle.
     *  Tìm bobbin trong _activeMovers HOẶC _checkoutQueue, dọn rope/tray rồi release pool. */
    public forceReleaseSingle(bobbin: Bobbin): boolean {
        // 1. _activeMovers
        for (let i = this._activeMovers.length - 1; i >= 0; i--) {
            const m = this._activeMovers[i];
            if (m.bobbin !== bobbin) continue;
            if (m.activeRope?.node?.isValid) {
                m.activeRope.node.destroy();
                m.activeRope = null;
            }
            this._activeMovers.splice(i, 1);
            if (m.tray) TrayManager.instance?.returnTray(m.tray, false);
            if (bobbin.node?.isValid) {
                bobbin.node.setScale(Vec3.ZERO);
                MapObjectSpawner.instance.releaseBobbin(bobbin.node);
            }
            return true;
        }
        // 2. _checkoutQueue (đang bay/staging)
        for (let i = this._checkoutQueue.length - 1; i >= 0; i--) {
            const p = this._checkoutQueue[i];
            if (p.bobbin !== bobbin) continue;
            if (p.useQueueTray && p.queueTraySlot >= 0)
                this._queueTrayOccupied[p.queueTraySlot] = false;
            if (p.tray) TrayManager.instance?.returnTray(p.tray, false);
            this._checkoutQueue.splice(i, 1);
            if (bobbin.node?.isValid) {
                bobbin.node.setScale(Vec3.ZERO);
                MapObjectSpawner.instance.releaseBobbin(bobbin.node);
            }
            return true;
        }
        return false;
    }

    private _hasBeltSpacing(): boolean {
        if (this._activeMovers.length >= this.maxTrays) return false;
        if (this._activeMovers.length > 0) {
            let lastMover = this._activeMovers[this._activeMovers.length - 1];
            if (lastMover.progress < this.minSpacing) return false;
        }
        return true;
    }

    private onBobbinCheckout(bobbin: Bobbin) {
        if (!this.startBobbin || !this.startTray || !this.spline || this.spline.wps.length < 2) {
            bobbin.shake();
            return;
        }

        // Port 1:1 từ Unity Bobbin.TryCheckout:213 — reset center về origin khi rời queue lên belt.
        // Lý do: trong queue setActiveState(false) dời center xuống -0.1 (để rope nối ở body bobbin).
        // Khi lên belt, bobbin nằm ngang → offset -0.1 trên local Y trở thành lệch ngang theo world,
        // khiến rope cylinder bị bobbin che mất 1 nửa. Set về (0,0,0) để khử offset này.
        if (bobbin.center) {
            bobbin.center.setPosition(0, 0, 0);
        }

        // Ẩn score1 ngay khi bắt đầu bay checkout
        bobbin.onCheckoutStart();

        // Khởi tạo slot array nếu chưa có
        if (this._queueTrayOccupied.length !== this.queueTraySlotCount) {
            this._queueTrayOccupied = new Array(this.queueTraySlotCount).fill(false);
        }

        const pending = new PendingCheckout();
        pending.bobbin = bobbin;

        // Tính góc xoay đích của tray trên belt
        const targetRot = new Quat();
        if (this.spline.wps.length >= 2) {
            const dir = new Vec3();
            Vec3.subtract(dir, this.spline.wps[1], this.spline.wps[0]).normalize();
            const steerRot = new Quat();
            Quat.fromViewUp(steerRot, dir, Vec3.UNIT_Y);
            const trayBaseRot = new Quat();
            Quat.fromEuler(trayBaseRot, this.trayBeltEuler.x, this.trayBeltEuler.y, this.trayBeltEuler.z);
            Quat.multiply(targetRot, steerRot, trayBaseRot);
        }

        // Giống Unity BeginCheckoutFly: kiểm tra có chỗ trên belt không.
        // QUAN TRỌNG: dùng structural check `_checkoutQueue.length === 0` thay vì wall-clock
        // `_lastExpectedBeltEntryTime <= Date.now()/1000`. Lý do: có 1 cửa sổ race giữa
        // moment bobbin A finish flying (bobbinFlyDone=true) và lúc processCheckoutQueue
        // dời A từ _checkoutQueue sang _activeMovers. Trong cửa sổ đó:
        //   - _activeMovers rỗng → _hasBeltSpacing = true
        //   - wall clock đã vượt _lastExpectedBeltEntryTime → wall-clock check pass
        //   - hasClearance = true → bobbin B sẽ đi thẳng tới startTray
        //   - Tray A và Tray B cùng đến startTray → chồng lên nhau (bug user báo).
        // Structural check đảm bảo B chỉ đi thẳng khi không còn ai đang pending trên đường.
        const hasClearance = this._checkoutQueue.length === 0 && this._hasBeltSpacing();
        const slotIdx = hasClearance ? -1 : this._findFreeQueueTraySlot();

        if (!hasClearance && slotIdx < 0) {
            // Không còn slot staging — vẫn bay thẳng như fallback (giống Unity)
        }

        if (!hasClearance && slotIdx >= 0) {
            // Path QueueTray: bay lên vị trí staging, sau đó drop xuống
            const queuePos = this._getDynamicQueueTrayPosition();
            pending.useQueueTray = true;
            pending.queueTraySlot = slotIdx;
            pending.queueTrayTargetPos.set(queuePos);
            this._queueTrayOccupied[slotIdx] = true;
            this._advanceExpectedBeltEntry(Date.now() / 1000 + this.bobbinFlyDuration +
                (queuePos.y - this.startTray.worldPosition.y) / this.queueTrayDropSpeed);

            const ok = TrayManager.instance.tryCheckout(
                queuePos,
                (arrivedTray: Tray) => {
                    pending.tray = arrivedTray;
                    pending.trayArrivedAtQueue = true;
                },
                targetRot
            );
            if (!ok) { bobbin.shake(); return; }

            // Bay lên vị trí staging
            this._startBobbinFly(pending, queuePos.clone(), this.bobbinFlyDuration);
        } else {
            // Path trực tiếp: bay thẳng đến startTray
            this._advanceExpectedBeltEntry(Date.now() / 1000 + this.bobbinFlyDuration);

            const ok = TrayManager.instance.tryCheckout(
                this.startTray.worldPosition,
                (arrivedTray: Tray) => {
                    pending.tray = arrivedTray;
                    pending.trayArrived = true;
                },
                targetRot
            );
            if (!ok) { bobbin.shake(); return; }

            this._startBobbinFly(pending, this.startBobbin.worldPosition.clone(), this.bobbinFlyDuration);
        }

        this._checkoutQueue.push(pending);
    }

    private _advanceExpectedBeltEntry(tArrive: number) {
        const tMinEntry = this._lastExpectedBeltEntryTime + this.minSpacing / this.spline.speed;
        this._lastExpectedBeltEntryTime = Math.max(tArrive, tMinEntry);
    }

    private _findFreeQueueTraySlot(): number {
        // Tìm slot cao nhất đang có bobbin đang rơi (chưa readyForBelt)
        let maxDroppingSlot = -1;
        for (const p of this._checkoutQueue) {
            if (p.useQueueTray && p.trayArrivedAtQueue && !p.readyForBelt)
                maxDroppingSlot = Math.max(maxDroppingSlot, p.queueTraySlot);
        }
        // Ưu tiên slot cao hơn slot đang rơi thấp nhất
        if (maxDroppingSlot >= 0) {
            for (let i = maxDroppingSlot + 1; i < this._queueTrayOccupied.length; i++)
                if (!this._queueTrayOccupied[i]) return i;
        }
        for (let i = 0; i < this._queueTrayOccupied.length; i++)
            if (!this._queueTrayOccupied[i]) return i;
        return -1;
    }

    private _getDynamicQueueTrayPosition(): Vec3 {
        // Tính Y cao nhất của bobbin đang trong queue (giống Unity GetDynamicQueueTrayPosition)
        let topY = Number.NEGATIVE_INFINITY;
        for (const p of this._checkoutQueue) {
            if (!p.useQueueTray || p.readyForBelt) continue;
            const y = (p.trayArrivedAtQueue && p.tray)
                ? p.tray.node.worldPosition.y
                : p.queueTrayTargetPos.y;
            if (y > topY) topY = y;
        }
        const basePos = this.startBobbin.worldPosition;
        if (topY === Number.NEGATIVE_INFINITY)
            return new Vec3(basePos.x, basePos.y + this.queueTrayStartSpacing, basePos.z);
        return new Vec3(basePos.x, topY + this.queueTrayBetweenSpacing, basePos.z);
    }

    private _startBobbinFly(pending: PendingCheckout, endPos: Vec3, duration: number) {
        const bobbin = pending.bobbin;
        if (!bobbin?.node?.isValid) return;

        const startPos = bobbin.node.worldPosition.clone();
        const controlY = Math.max(startPos.y, endPos.y) + 2.0;

        const rotFrom = bobbin.node.rotation.clone();
        const rotTo = new Quat();
        Quat.fromEuler(rotTo, 0, 0, 90);
        const tempPos = new Vec3();
        const tempRot = new Quat();
        const tempObj = { ratio: 0 };

        tween(tempObj)
            .to(duration, { ratio: 1 }, {
                onUpdate: () => {
                    const r = tempObj.ratio, inv = 1 - r;
                    const ctrlX = (startPos.x + endPos.x) * 0.5;
                    const ctrlZ = (startPos.z + endPos.z) * 0.5;
                    tempPos.x = inv*inv*startPos.x + 2*inv*r*ctrlX + r*r*endPos.x;
                    tempPos.y = inv*inv*startPos.y + 2*inv*r*controlY + r*r*endPos.y;
                    tempPos.z = inv*inv*startPos.z + 2*inv*r*ctrlZ + r*r*endPos.z;
                    bobbin.node.setWorldPosition(tempPos);

                    const rotT = r < 0.5 ? r / 0.5 : 1.0;
                    Quat.slerp(tempRot, rotFrom, rotTo, rotT);
                    bobbin.node.setRotation(tempRot);
                }
            })
            .call(() => {
                pending.bobbinFlyDone = true;
            })
            .start();
    }

    update(dt: number) {
        this.processCheckoutQueue(dt);
        this.updateMovers(dt);
    }

    private processCheckoutQueue(dt: number) {
        // 1. Xử lý drop cho tất cả QueueTray đang staging
        for (const p of this._checkoutQueue) {
            if (!p.useQueueTray || p.isFlying || p.readyForBelt) continue;

            // Seat bobbin lên tray tại vị trí staging (1 lần) — match Unity QueueTray seat
            if (!p['_seatedAtQueue']) {
                p['_seatedAtQueue'] = true;
                const seatNode = p.tray.positionBobbin ?? p.tray.node;
                p.bobbin.node.setParent(seatNode, false);
                p.bobbin.node.setPosition(Vec3.ZERO);
                const localRot = new Quat();
                Quat.fromEuler(localRot, 0, 180, -90);
                p.bobbin.node.setRotation(localRot);
                p.bobbin.node.setScale(Vec3.ONE);
                // Hiện score2 ngay khi ngồi lên tray staging, không chờ tray rơi xuống belt
                p.bobbin.onPlacedOnBelt();
            }

            // Drop tray xuống startTray
            const trayNode = p.tray.node;
            const targetY = this.startTray.worldPosition.y;
            const currentY = trayNode.worldPosition.y;
            if (currentY <= targetY + 0.001) {
                // Đến nơi
                p.readyForBelt = true;
                this._queueTrayOccupied[p.queueTraySlot] = false;
                p.tray.spawnArrivalFx();
                continue;
            }

            // Tính speed: freeze nếu tray phía dưới đang đợi; slow nếu gần startTray
            let speed = this.queueTrayDropSpeed;
            let hasWaitingBelow = false;
            for (const other of this._checkoutQueue) {
                if (other === p || !other.useQueueTray || !other.tray) continue;
                const otherY = other.tray.node.worldPosition.y;
                if (otherY >= currentY) continue;
                // Tray phía dưới đang đợi spacing
                if (other.readyForBelt || (currentY - otherY < this.queueTrayDropGapBetween)) {
                    hasWaitingBelow = true; break;
                }
            }
            if (hasWaitingBelow) speed = 0;

            if (speed > 0) {
                const newY = Math.max(targetY, currentY - speed * dt);
                const wp = trayNode.worldPosition.clone();
                wp.y = newY;
                trayNode.setWorldPosition(wp);
            }
        }

        // 2. Seat bobbin đầu hàng lên belt khi sẵn sàng
        if (this._checkoutQueue.length === 0) return;
        const p = this._checkoutQueue[0];

        // Direct path: chờ bay xong + tray đến (spacing đã check lúc click)
        if (!p.useQueueTray) {
            if (p.isFlying) return;
        } else {
            // QueueTray path: chờ đã rơi xuống startTray, sau đó check spacing
            if (!p.readyForBelt) return;
            if (!this._hasBeltSpacing()) return;
        }

        // Seat lên belt — match Unity 1:1: localPos=0, localRot=Euler(0,180,90), localScale=1
        if (!p.useQueueTray) {
            const seatNode = p.tray.positionBobbin ?? p.tray.node;
            p.bobbin.node.setParent(seatNode, false);
            p.bobbin.node.setPosition(Vec3.ZERO);
            const beltLocalRot = new Quat();
            Quat.fromEuler(beltLocalRot, 0, 180, -90);
            p.bobbin.node.setRotation(beltLocalRot);
            p.bobbin.node.setScale(Vec3.ONE);
            p.tray.spawnArrivalFx();
        }
        // QueueTray: bobbin đã được seat từ trước, chỉ cần thêm vào belt
        p.bobbin.onPlacedOnBelt();

        this._checkoutQueue.shift();
        const mover = new TrayMover();
        mover.bobbin = p.bobbin;
        mover.tray = p.tray;
        mover.progress = 0;
        mover.currentSegIdx = -1;
        mover.isFirstFrame = true;
        mover.rollAngle = 0;
        this._activeMovers.push(mover);
    }

    private updateMovers(dt: number) {
        if (!this.spline || this.spline.wps.length < 2) return;

        let step = this.spline.speed * dt;

        for (let i = this._activeMovers.length - 1; i >= 0; i--) {
            // Port 1:1 từ Unity SplineManager.Update:277 — handleConnectionCompleteOnBelt
            // có thể remove nhiều mover cùng lúc (toàn cluster), khiến i vượt array length.
            if (i >= this._activeMovers.length) break;
            let mover = this._activeMovers[i];
            if (!mover) break;

            // Mover không còn bobbin hợp lệ — dọn dẹp.
            if (!mover.bobbin || !mover.bobbin.isValid) {
                this.handleBobbinCompleteOnBelt(mover);
                continue;
            }

            mover.progress += step;

            if (mover.progress >= this._totalPathLength) {
                this.onMoverReachedEnd(mover, i);
                continue;
            }

            let currentDist = mover.progress;
            let segIdx = 0;
            while (segIdx < this._segLengths.length && currentDist > this._segLengths[segIdx]) {
                currentDist -= this._segLengths[segIdx];
                segIdx++;
            }
            if (segIdx >= this._segLengths.length) segIdx = this._segLengths.length - 1;

            if (segIdx !== mover.currentSegIdx) {
                mover.currentSegIdx = segIdx;
                mover.lastSnapDir = this._segSnapDirs[segIdx];
                mover.lastInward = this._segInwards[segIdx];
                mover.hasAnchor = false;
            }

            let p1 = this.spline.wps[segIdx];
            let p2 = this.spline.wps[segIdx + 1];
            let t = currentDist / this._segLengths[segIdx];

            let pos = new Vec3();
            Vec3.lerp(pos, p1, p2, t);

            if (this.yarnParent) {
                // Tray phải thấp hơn Yarn một khoảng bằng chiều cao của Tray
                // đến positionBobbin. Dùng trayYOffset để chỉnh sớn trong Inspector.
                pos.y = this.yarnParent.worldPosition.y + this.trayYOffset;
            }
            mover.tray.node.setWorldPosition(pos);

            let dir = new Vec3();
            Vec3.subtract(dir, p2, p1).normalize();
            let targetSteerRot = new Quat();
            Quat.fromViewUp(targetSteerRot, dir, Vec3.UNIT_Y);

            if (mover.isFirstFrame) {
                mover.steerRot.set(targetSteerRot);
                mover.isFirstFrame = false;
            } else {
                Quat.slerp(mover.steerRot, mover.steerRot, targetSteerRot, dt * this.turnSpeed);
            }

            // ── Tray: chỉ xoay theo hướng di chuyển, giữ phẳng nằm trên belt
            let trayBaseRot = new Quat();
            Quat.fromEuler(trayBaseRot, this.trayBeltEuler.x, this.trayBeltEuler.y, this.trayBeltEuler.z);
            let trayFinalRot = new Quat();
            Quat.multiply(trayFinalRot, mover.steerRot, trayBaseRot);
            mover.tray.node.setWorldRotation(trayFinalRot);

            // Bobbin là child của tray.positionBobbin với localRot Euler(0,180,90) cố định
            // → tự inherit rotation từ tray, không xoay riêng (giống Unity)
            if (mover.bobbin && mover.bobbin.node && mover.bobbin.node.isValid) {
                // Chỉ căn score2 đứng đúng dựa vào rotation Y của tray (giống Unity KeepScore2Upright)
                mover.bobbin.keepScore2Upright(mover.tray.node);
            }

            // Port 1:1 từ Unity SplineManager.Update — sau khi đã update vị trí,
            // nếu bobbin đang chờ connection complete:
            //   - connection bị clear (SuperBobbin purge) → complete ngay
            //   - connection còn → skip yarn firing, bobbin tiếp tục chạy trên belt
            if (mover.bobbin.pendingConnectionComplete) {
                if (!mover.bobbin.connection) {
                    this.handleBobbinCompleteOnBelt(mover);
                }
                continue;
            }

            // Origin của tia bắn: ưu tiên bobbin.shoot (giống Unity), fallback về vị trí Tray
            const origin = (mover.bobbin.shoot)
                ? mover.bobbin.shoot.worldPosition.clone()
                : pos.clone();

            let shouldFire = true;
            if (mover.hasAnchor) {
                if (mover.lastSnapDir.x > 0.5) shouldFire = origin.x >= mover.nextFirePos.x;
                else if (mover.lastSnapDir.x < -0.5) shouldFire = origin.x <= mover.nextFirePos.x;
                else if (mover.lastSnapDir.z > 0.5) shouldFire = origin.z >= mover.nextFirePos.z;
                else if (mover.lastSnapDir.z < -0.5) shouldFire = origin.z <= mover.nextFirePos.z;
            }

            if (shouldFire) {
                let fireOrigin = origin.clone();
                if (mover.hasAnchor) {
                    if (Math.abs(mover.lastSnapDir.x) > 0.5) fireOrigin.x = mover.nextFirePos.x;
                    else fireOrigin.z = mover.nextFirePos.z;
                }
                this.fireYarnRaycast(mover, fireOrigin, mover.lastInward);
            }

            if (mover.activeRope) {
                if (!mover.hasAnchor) {
                    mover.ropeReleaseTimer += dt;
                    if (mover.ropeReleaseTimer >= this.ropeReleaseDelay && mover.bobbin.data.ammo > 0) {
                        mover.activeRope.node.destroy();
                        mover.activeRope = null;
                        mover.ropeReleaseTimer = 0;
                    }
                } else {
                    mover.ropeReleaseTimer = 0;
                }
            }
        }
    }

    /** Port từ Unity SplineManager `cellW = mapGenerator.cellSize`.
     *  World cellSize = BoardScaler.cellSize * aboveParent.scale (parent scale ảnh hưởng).
     *  Fallback 0.1 nếu chưa wire — default BoardScaler.cellSize. */
    private _cellW(): number {
        const raw = this.boardScaler?.cellSize ?? 0.1;
        const parentScale = this.aboveParent?.scale.x ?? 1;
        return raw * parentScale;
    }

    private fireYarnRaycast(mover: TrayMover, origin: Vec3, inward: Vec3) {
        if (!mover.bobbin || mover.bobbin.data.ammo <= 0) return;

        // Base Y của ray = aboveParent.worldPosition.y (Y của yarn collider center) thay vì
        // bobbin.shoot.y. Lý do: bobbin.shoot có thể không cùng level với yarn, và khi
        // BoardScaler scale parent xuống cho ảnh lớn thì yarn collider Y-extent thu nhỏ tỉ lệ
        // → ray base Y phải bám theo yarn level. Offset cũng được nhân với scale.y cùng lý do.
        // Fallback origin.y nếu chưa wire aboveParent (giữ behavior cũ).
        const parentScaleY = this.aboveParent?.scale.y ?? 1;
        const baseY = this.aboveParent?.worldPosition.y ?? origin.y;
        let rayOriginY = baseY + this.raycastYOffset * parentScaleY;
        geometry.Ray.set(this._ray, origin.x, rayOriginY, origin.z, inward.x, inward.y, inward.z);
        let didHit = false;

        if (PhysicsSystem.instance.raycast(this._ray, 0xffffffff, this.raycastDistance, true)) {
            const results = PhysicsSystem.instance.raycastResults;
            results.sort((a, b) => a.distance - b.distance);

            for (let res of results) {
                let hitNode = res.collider.node;

                // BobbinWall priority — port 1:1 từ Unity SplineManager.FireYarnRaycast layer branch.
                // BobbinWallChild có thể nằm sâu trong hierarchy (child của center node của wall).
                let wallChild = hitNode.getComponent(BobbinWallChild);
                let parent = hitNode.parent;
                while (!wallChild && parent) {
                    wallChild = parent.getComponent(BobbinWallChild);
                    parent = parent.parent;
                }
                if (wallChild) {
                    // Tìm BobbinWall ancestor
                    let wall: BobbinWall | null = null;
                    let p2 = wallChild.node.parent;
                    while (!wall && p2) {
                        wall = p2.getComponent(BobbinWall);
                        p2 = p2.parent;
                    }
                    if (wall && mover.bobbin.handleBobbinWallHit(wall)) {
                        this.handleBobbinWallRopeAndAnchor(mover, wall, res.collider);
                        didHit = true;
                    }
                    // Material mismatch hoặc wall đã chết → block raycast (Unity: single-hit raycast dừng tại đây).
                    break;
                }

                // Key check — port 1:1 từ Unity SplineManager FireYarnRaycast nhánh _keyLayer.
                // Key có thể nằm sâu trong hierarchy nên search lên parent.
                let keyComp = hitNode.getComponent(Key);
                let pk = hitNode.parent;
                while (!keyComp && pk) {
                    keyComp = pk.getComponent(Key);
                    pk = pk.parent;
                }
                if (keyComp) {
                    console.log('[KeyHit] raycast trúng Key node=', keyComp.node.name, 'pos=', keyComp.node.worldPosition);
                    const ok = mover.bobbin.handleKeyHit(keyComp);
                    console.log('[KeyHit] handleKeyHit result=', ok);
                    if (ok) didHit = true;
                    break;
                }

                // Barrier check — search Barrier component qua hitNode + ancestors.
                // BarrierCollider marker là OPTIONAL (Unity dùng để filter, Cocos thì bất kỳ
                // collider nào có Barrier ancestor đều trigger). Bobbin sẽ damage barrier khi
                // raycast trúng head/body/tail — không cần đính BarrierCollider lên từng node.
                let barrier: Barrier | null = hitNode.getComponent(Barrier);
                let pb = hitNode.parent;
                while (!barrier && pb) {
                    barrier = pb.getComponent(Barrier);
                    pb = pb.parent;
                }
                if (barrier) {
                    if (mover.bobbin.handleBarrierHit(barrier)) {
                        // Unity: isMatch=true → trừ ammo bobbin + setup anchor/rope tại hit.point.
                        this.handleBarrierRopeAndAnchor(mover, res.hitPoint, res.collider);
                        didHit = true;
                    }
                    // Mismatch material / dead barrier → block ray (single-hit semantic).
                    break;
                }

                let yarn = hitNode.getComponent(Yarn);
                let p = hitNode.parent;
                while (!yarn && p) {
                    yarn = p.getComponent(Yarn);
                    p = p.parent;
                }

                if (yarn && yarn.data) {
                    if (yarn.data.material === mover.bobbin.data.material) {
                        this.handleYarnHit(mover, yarn, res.hitPoint, res.collider);
                        didHit = true;
                        break;
                    } else {
                        break;
                    }
                } else if (hitNode.name !== "Belt" && hitNode.name !== "Bobbin") {
                    if (!mover["_hasLoggedBlock"]) {
                        mover["_hasLoggedBlock"] = true;
                    }
                }
            }
        }

        if (!didHit) {
            mover.hasAnchor = false;
            if (!mover["_hasLoggedMiss"]) {
                mover["_hasLoggedMiss"] = true;
            }
        }
    }

    private handleYarnHit(mover: TrayMover, yarn: Yarn, hitPoint: Vec3, collider: import('cc').Collider) {
        mover.bobbin.decrementAmmo();
        mover.ropeReleaseTimer = 0;
        mover.hasAnchor = true;

        // Unity: cellW = mapGenerator.cellSize (constant). KHÔNG đọc từ collider bounds vì
        // barrier/long colliders sẽ trả về halfExtents khổng lồ.
        const cellSize = this._cellW();

        let nextPos = new Vec3();
        Vec3.scaleAndAdd(nextPos, yarn.node.worldPosition, mover.lastSnapDir, cellSize);
        mover.nextFirePos = nextPos;

        let tPos = yarn.node.worldPosition.clone();
        // Cùng lý do với raycast: scale offset theo aboveParent để rope không "bay" trên đầu yarn
        tPos.y += this.raycastYOffset * (this.aboveParent?.scale.y ?? 1);

        mover.ropeReleaseTimer = 0;

        if (!mover.activeRope && this.ropePrefab) {
            let ropeNode = instantiate(this.ropePrefab);
            this.node.addChild(ropeNode);
            mover.activeRope = ropeNode.getComponent(RopeSimulator) || ropeNode.addComponent(RopeSimulator);
            mover.activeRope.pointA = mover.bobbin.node;
            mover.activeRope.targetPos = tPos;
            mover.activeRope.setColor(mover.bobbin.currentColor);
            mover.activeRope.forceRefresh();
        } else if (mover.activeRope) {
            mover.activeRope.targetPos = tPos;
        }

        yarn.despawn(() => {
            GameManager.instance?.removeYarn(yarn);
            if (yarn.node?.isValid) yarn.node.destroy();
        });

        if (mover.bobbin.data.ammo <= 0) {
            // Port 1:1 từ Unity SplineManager.OnBobbinScoreZero
            if (!mover.bobbin.connection) {
                this.handleBobbinCompleteOnBelt(mover);
            } else {
                mover.bobbin.pendingConnectionComplete = true;
                // Release rope (đã bắn xong, không cần kéo)
                if (mover.activeRope) {
                    const rope = mover.activeRope;
                    mover.activeRope = null;
                    this.scheduleOnce(() => { if (rope?.node?.isValid) rope.node.destroy(); }, 0.1);
                }
                if (mover.bobbin.connection.allMembersPendingComplete()) {
                    this.handleConnectionCompleteOnBelt(mover.bobbin.connection);
                }
            }
        }
    }

    /** Port từ Unity SplineManager.FireYarnRaycast nhánh Barrier (line 359-409):
     *  Bobbin.handleBarrierHit đã damage barrier. Hàm này:
     *  - Trừ ammo bobbin (Unity `if (isMatch) mover.Bobbin.score--`)
     *  - Setup anchor + rope target tại hit.point (KHÔNG phải collider.bounds.center vì barrier dài)
     *  - Tính nextFirePos = hit.point + snapDir * cellSize
     *  - Check completion khi ammo = 0. */
    private handleBarrierRopeAndAnchor(mover: TrayMover, hitPoint: Vec3, _collider: import('cc').Collider) {
        mover.bobbin.decrementAmmo();
        mover.ropeReleaseTimer = 0;
        mover.hasAnchor = true;

        // CRITICAL: Barrier body collider có halfExtents lớn (nửa chiều dài body),
        // dùng nó cho cellSize sẽ làm nextFirePos cách quá xa → bobbin chỉ damage 1 lần
        // trong cả pass. Phải dùng cellW từ BoardScaler (port Unity `cellW = cellSize`).
        const cellSize = this._cellW();

        const nextPos = new Vec3();
        Vec3.scaleAndAdd(nextPos, hitPoint, mover.lastSnapDir, cellSize);
        mover.nextFirePos = nextPos;

        const tPos = hitPoint.clone();
        tPos.y += this.raycastYOffset * (this.aboveParent?.scale.y ?? 1);

        if (!mover.activeRope && this.ropePrefab) {
            const ropeNode = instantiate(this.ropePrefab);
            this.node.addChild(ropeNode);
            mover.activeRope = ropeNode.getComponent(RopeSimulator) || ropeNode.addComponent(RopeSimulator);
            mover.activeRope.pointA = mover.bobbin.node;
            mover.activeRope.targetPos = tPos;
            mover.activeRope.setColor(mover.bobbin.currentColor);
            mover.activeRope.forceRefresh();
        } else if (mover.activeRope) {
            mover.activeRope.targetPos = tPos;
        }

        // Completion check khi ammo về 0
        if (mover.bobbin.data.ammo <= 0) {
            if (!mover.bobbin.connection) {
                this.handleBobbinCompleteOnBelt(mover);
            } else {
                mover.bobbin.pendingConnectionComplete = true;
                if (mover.activeRope) {
                    const rope = mover.activeRope;
                    mover.activeRope = null;
                    this.scheduleOnce(() => { if (rope?.node?.isValid) rope.node.destroy(); }, 0.1);
                }
                if (mover.bobbin.connection.allMembersPendingComplete()) {
                    this.handleConnectionCompleteOnBelt(mover.bobbin.connection);
                }
            }
        }
    }

    /** Port từ Unity SplineManager.FireYarnRaycast nhánh BobbinWall:
     *  Bobbin.handleBobbinWallHit đã decrement ammo + damage wall + punch/splash.
     *  Hàm này chỉ chịu trách nhiệm anchor/rope/nextFirePos (cùng pattern handleYarnHit)
     *  và check completion khi ammo về 0. */
    private handleBobbinWallRopeAndAnchor(mover: TrayMover, wall: BobbinWall, _collider: import('cc').Collider) {
        mover.ropeReleaseTimer = 0;
        mover.hasAnchor = true;

        // Unity dùng cellW constant — KHÔNG đọc từ collider bounds.
        const cellSize = this._cellW();

        // Rope target = wall center (hoặc node) — match cách Yarn dùng yarn.node.worldPosition
        const wallTarget = (wall.center ?? wall.node).worldPosition;

        const nextPos = new Vec3();
        Vec3.scaleAndAdd(nextPos, wallTarget, mover.lastSnapDir, cellSize);
        mover.nextFirePos = nextPos;

        const tPos = wallTarget.clone();
        tPos.y += this.raycastYOffset * (this.aboveParent?.scale.y ?? 1);

        if (!mover.activeRope && this.ropePrefab) {
            const ropeNode = instantiate(this.ropePrefab);
            this.node.addChild(ropeNode);
            mover.activeRope = ropeNode.getComponent(RopeSimulator) || ropeNode.addComponent(RopeSimulator);
            mover.activeRope.pointA = mover.bobbin.node;
            mover.activeRope.targetPos = tPos;
            mover.activeRope.setColor(mover.bobbin.currentColor);
            mover.activeRope.forceRefresh();
        } else if (mover.activeRope) {
            mover.activeRope.targetPos = tPos;
        }

        if (mover.bobbin.data.ammo <= 0) {
            if (!mover.bobbin.connection) {
                this.handleBobbinCompleteOnBelt(mover);
            } else {
                mover.bobbin.pendingConnectionComplete = true;
                if (mover.activeRope) {
                    const rope = mover.activeRope;
                    mover.activeRope = null;
                    this.scheduleOnce(() => { if (rope?.node?.isValid) rope.node.destroy(); }, 0.1);
                }
                if (mover.bobbin.connection.allMembersPendingComplete()) {
                    this.handleConnectionCompleteOnBelt(mover.bobbin.connection);
                }
            }
        }
    }

    /** Hoàn thành toàn bộ bobbin trong một connection cùng lúc.
     *  Port 1:1 từ Unity SplineManager.HandleConnectionCompleteOnBelt. */
    private handleConnectionCompleteOnBelt(conn: Connection): void {
        // Loop 1: bobbin đang trên belt → complete qua TrayMover
        const toComplete: TrayMover[] = [];
        for (const m of this._activeMovers) {
            if (m.bobbin && (conn.members.indexOf(m.bobbin) >= 0 || m.bobbin.connection === conn)) {
                toComplete.push(m);
            }
        }
        for (const m of toComplete) this.handleBobbinCompleteOnBelt(m);
        let anyCompleted = toComplete.length > 0;

        // Loop 2: bobbin đã ở hàng chờ hoặc đang bay về → complete trực tiếp / mark for completion
        const snapshot = conn.members.slice();
        for (const bobbin of snapshot) {
            if (!bobbin.pendingConnectionComplete) continue;
            // Bỏ qua bobbin đã được xử lý ở loop 1
            let alreadyHandled = false;
            for (const m of toComplete) if (m.bobbin === bobbin) { alreadyHandled = true; break; }
            if (alreadyHandled) continue;

            if (QueueManager.instance?.isQueued(bobbin)) {
                // Đã đáp xuống bottom queue — xóa khỏi queue và complete ngay
                QueueManager.instance.onBobbinLeave(bobbin);
                this._playCompletionAndRelease(bobbin);
            } else {
                // Đang bay về queue — đánh dấu, complete khi đáp
                bobbin.markedForCompletion = true;
            }
            anyCompleted = true;
        }

        // Port 1:1 từ Unity: release Connection (kéo theo release tất cả ConnectionChild rope)
        if (anyCompleted && conn?.node?.isValid) {
            MapObjectSpawner.instance.releaseConnection(conn.node);
        }
    }

    private _playCompletionAndRelease(bobbin: Bobbin): void {
        if (!bobbin?.node?.isValid) return;
        tween(bobbin.node).to(0.2, { scale: Vec3.ZERO })
            .call(() => {
                if (bobbin.node?.isValid) MapObjectSpawner.instance.releaseBobbin(bobbin.node);
            }).start();
    }

    private handleBobbinCompleteOnBelt(mover: TrayMover) {
        let idx = this._activeMovers.indexOf(mover);
        if (idx !== -1) {
            this._activeMovers.splice(idx, 1);
        }

        if (mover.activeRope) {
            // Delay destruction so user sees the last hit (giống Unity DelayedReleaseRope 0.1f)
            const rope = mover.activeRope;
            mover.activeRope = null;
            this.scheduleOnce(() => { if (rope?.node?.isValid) rope.node.destroy(); }, 0.1);
        }

        // Tách Bobbin ra khỏi Tray trước khi trả Tray và destroy Bobbin
        if (mover.bobbin && mover.tray) {
            mover.bobbin.node.setParent(this.node, true);
        }

        if (mover.bobbin) {
            const b = mover.bobbin;
            tween(b.node)
                .to(0.2, { scale: Vec3.ZERO })
                .call(() => {
                    if (b.node?.isValid) MapObjectSpawner.instance.releaseBobbin(b.node);
                })
                .start();
        }

        // Trả chiếc xe Gòn (Tray) rỗng về lại kho của TrayManager
        if (mover.tray) {
            TrayManager.instance.returnTray(mover.tray, false);
            mover.tray = null;
        }
    }

    private onMoverReachedEnd(mover: TrayMover, idx: number) {
        if (idx !== -1) this._activeMovers.splice(idx, 1);
        if (mover.activeRope) {
            mover.activeRope.node.destroy();
            mover.activeRope = null;
        }

        // Tách Bobbin ra khỏi Tray trước khi trả Tray
        if (mover.bobbin && mover.tray) {
            mover.bobbin.node.setParent(this.node, true);
        }

        // Trả xe gòn về kho có hiệu ứng bounce
        if (mover.tray) {
            TrayManager.instance.returnTray(mover.tray, true);
            mover.tray = null;
        }

        const bobbin = mover.bobbin;
        if (!bobbin) return;

        // Port 1:1 từ Unity SplineManager.CompleteMoverEnd — nhánh PendingConnectionComplete
        if (bobbin.pendingConnectionComplete) {
            if (bobbin.connection && bobbin.connection.allMembersPendingComplete()) {
                this.handleConnectionCompleteOnBelt(bobbin.connection);
                // handleConnectionCompleteOnBelt đã set markedForCompletion cho các member còn bay
                // → tryReturn vẫn cần gọi để bobbin này bay về queue rồi mới complete (giữ animation)
                if (bobbin.markedForCompletion) {
                    QueueManager.instance.tryReturn(bobbin);
                }
            } else {
                // Chờ các member khác hoàn thành — về hàng chờ như bình thường
                QueueManager.instance.tryReturn(bobbin);
            }
            return;
        }

        // Thử trả về BottomQueue trước, nếu đầy thì thử OverflowQueue (giống Unity CompleteMoverEnd)
        const returned = QueueManager.instance.tryReturn(bobbin);
        if (!returned) {
            if (OverflowQueue.instance?.hasSpace) {
                OverflowQueue.instance.addBobbin(bobbin);
            } else {
                console.warn("[SplineManager] Game Over! Tất cả queue đầy!");
                tween(bobbin.node).to(0.2, { scale: Vec3.ZERO }).call(() => {
                    if (bobbin.node?.isValid) MapObjectSpawner.instance.releaseBobbin(bobbin.node);
                }).start();
            }
        }
    }
}
