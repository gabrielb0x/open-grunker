/**
 * Open Grunker — domination capture points.
 *
 * Each point is a translucent cylinder marking the capture radius, a floating
 * letter, and a ring that fills as it is taken. All of it is colour-coded by
 * owner, so a glance across the map tells you who holds what — which is the
 * whole reason the mode works without a minimap overlay.
 */
import * as THREE from 'three';
import * as K from '/shared/constants.js';

const TEAM_HEX = {
  [K.TEAM.NONE]: 0xc8ced6,
  [K.TEAM.RED]: 0xff4d4d,
  [K.TEAM.BLUE]: 0x4d9bff,
};

function letterTexture(letter) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = '800 92px Bahnschrift, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,.85)';
  g.strokeText(letter, 64, 66);
  g.fillStyle = '#ffffff';
  g.fillText(letter, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Objectives {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.points = [];
    this.time = 0;
  }

  /** Rebuilds the markers for a map's point list. */
  setPoints(list = []) {
    this.clear();
    for (const p of list) {
      const holder = new THREE.Group();
      holder.position.set(p.x, p.y, p.z);

      const zoneMat = new THREE.MeshBasicMaterial({
        color: TEAM_HEX[K.TEAM.NONE], transparent: true, opacity: 0.12,
        depthWrite: false, side: THREE.DoubleSide, fog: true,
      });
      const zone = new THREE.Mesh(
        new THREE.CylinderGeometry(K.DOM_CAPTURE_RADIUS, K.DOM_CAPTURE_RADIUS, 0.06, 30, 1, true),
        zoneMat,
      );
      zone.position.y = 0.03;

      const ringMat = new THREE.MeshBasicMaterial({
        color: TEAM_HEX[K.TEAM.NONE], transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide, fog: true,
      });
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(K.DOM_CAPTURE_RADIUS - 0.28, K.DOM_CAPTURE_RADIUS, 40),
        ringMat,
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;

      // The progress arc: a partial ring drawn over the base one.
      const progMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const prog = new THREE.Mesh(
        new THREE.RingGeometry(K.DOM_CAPTURE_RADIUS - 0.5, K.DOM_CAPTURE_RADIUS, 40, 1, Math.PI / 2, 0.001),
        progMat,
      );
      prog.rotation.x = -Math.PI / 2;
      prog.position.y = 0.07;
      prog.visible = false;

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.28, 6, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: TEAM_HEX[K.TEAM.NONE], transparent: true, opacity: 0.22,
          depthWrite: false, side: THREE.DoubleSide, fog: true,
        }),
      );
      beam.position.y = 3;

      const tex = letterTexture(p.id);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, fog: false,
      }));
      label.scale.set(1.6, 1.6, 1);
      label.position.y = 3.6;
      label.renderOrder = 6;

      holder.add(zone, ring, prog, beam, label);
      this.group.add(holder);
      this.points.push({
        id: p.id, holder, zone, ring, prog, beam, label, tex,
        owner: K.TEAM.NONE, progress: 0, contender: K.TEAM.NONE, contested: false,
        x: p.x, y: p.y, z: p.z,
      });
    }
  }

  /** Applies a server objective update. */
  apply(list = []) {
    for (const upd of list) {
      const pt = this.points.find((p) => p.id === upd.id);
      if (!pt) continue;
      pt.owner = upd.owner;
      pt.progress = upd.progress;
      pt.contender = upd.contender;
      pt.contested = upd.contested;

      const col = TEAM_HEX[upd.owner] ?? TEAM_HEX[K.TEAM.NONE];
      pt.zone.material.color.setHex(col);
      pt.ring.material.color.setHex(col);
      pt.beam.material.color.setHex(col);

      const capturing = upd.contender !== K.TEAM.NONE && upd.contender !== upd.owner && upd.progress > 0.01;
      pt.prog.visible = capturing;
      if (capturing) {
        pt.prog.geometry.dispose();
        pt.prog.geometry = new THREE.RingGeometry(
          K.DOM_CAPTURE_RADIUS - 0.5, K.DOM_CAPTURE_RADIUS, 40, 1,
          Math.PI / 2, -Math.PI * 2 * Math.min(1, upd.progress),
        );
        pt.prog.material.color.setHex(TEAM_HEX[upd.contender] ?? 0xffffff);
      }
    }
  }

  update(dt, camera) {
    if (!this.points.length) return;
    this.time += dt;
    const pulse = 0.5 + Math.sin(this.time * 2.4) * 0.5;
    for (const pt of this.points) {
      const base = pt.owner === K.TEAM.NONE ? 0.12 : 0.18;
      pt.zone.material.opacity = pt.contested ? base + pulse * 0.22 : base;
      pt.ring.material.opacity = pt.contested ? 0.45 + pulse * 0.5 : 0.55;
      pt.beam.material.opacity = 0.16 + pulse * 0.1;
      if (camera) {
        const d = camera.position.distanceTo(pt.holder.position);
        const s = Math.max(1.2, Math.min(5, d / 16));
        pt.label.scale.set(s, s, 1);
        pt.label.position.y = 3.6 + s * 0.2;
      }
    }
  }

  /** Ownership summary for the HUD strip. */
  get state() {
    return this.points.map((p) => ({
      id: p.id, owner: p.owner, progress: p.progress,
      contender: p.contender, contested: p.contested,
    }));
  }

  clear() {
    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const holder = this.group.children[i];
      this.group.remove(holder);
      holder.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); }
      });
    }
    this.points.length = 0;
  }
}

export default Objectives;
