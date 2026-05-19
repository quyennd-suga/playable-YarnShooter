import { _decorator, Component } from 'cc';
const { ccclass } = _decorator;

/**
 * Port 1:1 từ Unity BarrierCollider.cs.
 * Marker component đặt trên các collider con của Barrier.
 * Bobbin raycast trúng → search lên parent tìm Barrier component.
 */
@ccclass('BarrierCollider')
export class BarrierCollider extends Component {}
