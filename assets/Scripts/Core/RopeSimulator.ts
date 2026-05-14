import { _decorator, Component, Node, Vec3, Line, math, Color, game } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('RopeSimulator')
export class RopeSimulator extends Component {
    @property(Node) public pointA: Node = null; // Bobbin
    @property(Vec3) public targetPos: Vec3 = new Vec3(); // pointB

    @property public segments: number = 40;
    @property public amplitude: number = 0.035;
    @property public frequency: number = 2.0;
    @property public waveSpeed: number = 2.0;
    @property public wavePhase: number = 0.0;
    @property({ range: [0, 1] }) public waveRandomness: number = 0.0;

    @property public pointBFollowSpeed: number = 12.0;
    @property public introTime: number = 0.02;
    @property(Vec3) public pointAOffset: Vec3 = null;

    private _line: Line = null;
    private _smoothedB: Vec3 = new Vec3();
    private _introTimer: number = 0;
    private _positions: Vec3[] = [];
    private _sysTime: number = 0;

    onLoad() {
        // Ép cứng các thông số sóng (bỏ qua giá trị lưu trong Prefab) để đảm bảo đồng bộ
        this.frequency = 2.0;
        this.amplitude = 0.045; // Tăng lại một chút vì 0.035 quá nhỏ làm mất sóng
        this.waveSpeed = 15.0; // Tăng tốc độ lượn sóng lên một chút xíu cho đẹp mắt
        this.introTime = 0.0; // Tắt hoàn toàn intro để sóng bung lập tức
        this.pointBFollowSpeed = 6.0; // Giảm tốc độ quét ngang để thấy rõ dây lướt đi (Lerp mượt hơn)

        // Lấy hoặc tự động thêm Component Line
        this._line = this.getComponent(Line) || this.addComponent(Line);
        this._line.worldSpace = true;

        for (let i = 0; i <= this.segments; i++) {
            this._positions.push(new Vec3());
        }

        this._smoothedB.set(this.targetPos);
    }

    public setColor(color: Color) {
        if (!this._line) this._line = this.getComponent(Line) || this.addComponent(Line);

        let mat = this._line.getMaterialInstance(0);
        if (!mat) return;

        // colorA = màu chính (đậm) của bobbin
        mat.setProperty('colorA', color);
        // colorB = màu sọc highlight, tự động chọn sáng/tối để luôn tách được khỏi colorA
        mat.setProperty('colorB', RopeSimulator.computeStripeColor(color));
    }

    /** Tính màu sọc đối lập (colorB) cho shader mk-toon-stripe.
     *  - Nếu color đủ tối/đậm: lerp 50% về phía trắng (giữ behavior cũ — sọc sáng hơn).
     *  - Nếu color quá gần trắng (min channel cao): lerp về đen thay → vẫn tách rõ 2 màu sọc.
     *  Lý do: với color gần trắng (vd 255,255,255 hay pastel nhạt), càng lerp về trắng càng mờ. */
    public static computeStripeColor(color: Color): Color {
        const minChannel = Math.min(color.r, color.g, color.b);
        const tooCloseToWhite = minChannel > 180;
        const target = tooCloseToWhite ? 0 : 255;
        const factor = tooCloseToWhite ? 0.15 : 0.50;
        return new Color(
            Math.round(color.r + (target - color.r) * factor),
            Math.round(color.g + (target - color.g) * factor),
            Math.round(color.b + (target - color.b) * factor),
            color.a
        );
    }

    public forceRefresh() {
        // Bỏ dòng reset _introTimer để sóng không bị bóp nghẹt khi bắn liên thanh
        this._smoothedB.set(this.targetPos);
        this.updatePositions();
    }

    private pseudoNoise(x: number, y: number): number {
        let value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
        return value - Math.floor(value); // [0, 1)
    }

    update(dt: number) {
        if (!this.pointA) return;

        this._sysTime += dt;

        if (this.introTime > 0) {
            this._introTimer += dt;
        }

        if (this.pointBFollowSpeed > 0) {
            Vec3.lerp(this._smoothedB, this._smoothedB, this.targetPos, this.pointBFollowSpeed * dt);
        } else {
            this._smoothedB.set(this.targetPos);
        }

        this.updatePositions();
    }

    private updatePositions() {
        let posA = this.pointA.worldPosition.clone();
        if (this.pointAOffset) {
            posA.add(this.pointAOffset);
        }

        let dir = new Vec3();
        Vec3.subtract(dir, this._smoothedB, posA);
        let len = dir.length();
        if (len < 1e-5) return;

        let fwdN = dir.clone().normalize();
        
        // Vuông góc trên mặt phẳng XZ
        let perp = new Vec3(-fwdN.z, 0, fwdN.x);

        // Dùng Thời gian hệ thống của Engine (chuẩn và mượt hơn Date.now) để pha sóng uốn lượn liên tục
        let t = (game.totalTime / 1000) * this.waveSpeed;
        let introBlend = 1.0;

        if (this.introTime > 0) {
            let ratio = math.clamp01(this._introTimer / this.introTime);
            // SmoothStep
            introBlend = ratio * ratio * (3 - 2 * ratio);
        }

        let invSegments = 1.0 / this.segments;
        let useNoise = this.waveRandomness > 0;

        for (let i = 0; i <= this.segments; i++) {
            let frac = i * invSegments;
            let basePos = new Vec3();
            Vec3.lerp(basePos, posA, this._smoothedB, frac);

            let envelope = Math.sin(frac * Math.PI);
            let traveling = Math.sin(frac * this.frequency * Math.PI * 2 - t + this.wavePhase);
            let wave = 0;

            if (useNoise) {
                let noise = (this.pseudoNoise(frac * 3, t * 0.5) - 0.5) * 2;
                wave = envelope * math.lerp(traveling, noise, this.waveRandomness) * this.amplitude * introBlend;
            } else {
                wave = envelope * traveling * this.amplitude * introBlend;
            }

            let offset = new Vec3();
            Vec3.multiplyScalar(offset, perp, wave);
            if (!this._positions[i]) {
                this._positions[i] = new Vec3();
            }
            Vec3.add(this._positions[i], basePos, offset);
        }

        // Tạo mảng mới (slice) để ép Cocos Line cập nhật lại Mesh, tránh lỗi bị cache reference
        this._line.positions = this._positions.slice();
    }
}
