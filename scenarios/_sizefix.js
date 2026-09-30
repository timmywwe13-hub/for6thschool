// _sizefix probe: the two boxes that decide whether a skin is the right size -
// the model on the player AND the model the Locker puts on its turntable -
// measured the way the GPU draws them (getVertexPosition + matrixWorld) for
// every skin in the roster.
// Run it with:  node cdp-test.js _sizefix
module.exports = async function sizefix(ctx) {
  const { evaluate, check, sleep } = ctx;

  const PROBE = `(function () {
    /* the same pass Character's normaliser uses: every vertex through the
       skinning chain, then the mesh's world matrix */
    window.__boxOf = function (node) {
      if (!node) return null;
      /* updateMatrixWorld: it is what refreshes a SkinnedMesh's
         bindMatrixInverse, i.e. what makes this the drawn box */
      node.updateMatrixWorld(true);
      var v = new THREE.Vector3();
      var lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
      var meshes = 0;
      node.traverse(function (o) {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        var pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        if (!pos) return;
        meshes++;
        var sk = !!(o.isSkinnedMesh && o.skeleton);
        for (var i = 0; i < pos.count; i += 2) {
          if (sk) o.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
          v.applyMatrix4(o.matrixWorld);
          lo.min(v); hi.max(v);
        }
      });
      if (!meshes) return null;
      return { y: +(hi.y - lo.y).toFixed(3), minY: +lo.y.toFixed(3),
               x: +(hi.x - lo.x).toFixed(3), z: +(hi.z - lo.z).toFixed(3), meshes: meshes };
    };
    window.__box3Of = function (node) {
      if (!node) return null;
      var b = new THREE.Box3().setFromObject(node);
      return { y: +(b.max.y - b.min.y).toFixed(3), minY: +b.min.y.toFixed(3),
               x: +(b.max.x - b.min.x).toFixed(3) };
    };
    window.__skinState = function () {
      return { skin: PlayerView.skin(), status: Character.state.status, using: PlayerView.usingModel() };
    };
    return 'ready';
  })()`;
  await evaluate(PROBE);

  const TARGET = await evaluate(`CONFIG.CHARACTER.height`);
  const ids = ['freddy', 'bonnie', 'michael', 'ghost', 'demi', 'aura'];
  for (const id of ids) {
    await evaluate(`PlayerView.setSkin('` + id + `'); 'go'`);
    let st = null;
    for (let i = 0; i < 250; i++) {
      st = JSON.parse(await evaluate(`JSON.stringify(window.__skinState())`));
      if (st.skin === id && st.status === 'ready' && st.using) break;
      await sleep(300);
    }
    const onPlayer = JSON.parse(await evaluate(
      `JSON.stringify(window.__boxOf(App.scene.getObjectByName('playerCharacterModel')))`));
    /* the Locker's own instance: a second parse of the same bytes */
    await evaluate(`window.__pv = null;
      Character.preview('` + id + `').then(function (h) { window.__pv = h; }); 'go'`);
    for (let i = 0; i < 250 && !(await evaluate('!!window.__pv')); i++) await sleep(200);
    const preview = JSON.parse(await evaluate(`JSON.stringify(window.__boxOf(window.__pv))`));
    await evaluate(`window.__pv = null; 'ok'`);

    console.log('  ' + id.padEnd(8) + ' on the player ' + JSON.stringify(onPlayer) +
                '\n           locker preview ' + JSON.stringify(preview));
    check(id + ' stands the player height (' + TARGET + ' m)',
      onPlayer && Math.abs(onPlayer.y - TARGET) < 0.09 && Math.abs(onPlayer.minY) < 0.05,
      onPlayer ? (onPlayer.y + ' m, soles at ' + onPlayer.minY) : 'no model');
    check(id + ' is the same size on the Locker turntable',
      preview && Math.abs(preview.y - TARGET) < 0.09 && Math.abs(preview.minY) < 0.05,
      preview ? (preview.y + ' m, soles at ' + preview.minY) : 'no model');
  }
};
