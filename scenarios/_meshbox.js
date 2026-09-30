// _meshbox probe: every mesh of a skin, one drawn world box each (measured
// with a fresh bindMatrixInverse, i.e. what the GPU draws), plus the union.
//  node cdp-test.js _meshbox aura
module.exports = async function meshbox(ctx) {
  const { evaluate, sleep } = ctx;
  const id = process.argv[3] || 'aura';
  await evaluate(`(function () {
    window.__meshBoxes = function (node) {
      if (!node) return null;
      /* updateMatrixWorld, so every SkinnedMesh's bindMatrixInverse is fresh */
      node.updateMatrixWorld(true);
      var v = new THREE.Vector3();
      var lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
      var rows = [];
      node.traverse(function (o) {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        var pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        if (!pos) return;
        var a = new THREE.Vector3(1e9, 1e9, 1e9), b = new THREE.Vector3(-1e9, -1e9, -1e9);
        var sk = !!(o.isSkinnedMesh && o.skeleton);
        for (var i = 0; i < pos.count; i++) {
          if (sk) o.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
          v.applyMatrix4(o.matrixWorld);
          a.min(v); b.max(v); lo.min(v); hi.max(v);
        }
        rows.push({ mesh: (o.name || '?').slice(0, 34), skinned: sk,
                    y: [+a.y.toFixed(3), +b.y.toFixed(3)],
                    x: [+a.x.toFixed(3), +b.x.toFixed(3)],
                    z: [+a.z.toFixed(3), +b.z.toFixed(3)] });
      });
      return { meshes: rows,
               union: { y: [+lo.y.toFixed(3), +hi.y.toFixed(3)],
                        x: [+lo.x.toFixed(3), +hi.x.toFixed(3)],
                        z: [+lo.z.toFixed(3), +hi.z.toFixed(3)] } };
    };
    return 'ready';
  })()`);
  await evaluate(`PlayerView.setSkin('` + id + `'); 'go'`);
  await sleep(4000);
  const out = JSON.parse(await evaluate(
    `JSON.stringify(window.__meshBoxes(App.scene.getObjectByName('playerCharacterModel')))`));
  console.log('  ' + id + ' union  ' + JSON.stringify(out.union));
  out.meshes.forEach(m => console.log('    ' + JSON.stringify(m)));
};
