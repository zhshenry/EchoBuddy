import assert from 'node:assert/strict';
import test from 'node:test';
import { dockAfterDrag, dockBounds } from '../electron/overlay-position';

const screen = { id: 7, workArea: { x: -1440, y: 24, width: 1440, height: 876 } };

test('dragging to the top keeps the floating bar in the dropped horizontal position', () => {
  const drop = { x: -900, y: 24, width: 368, height: 88 };
  const dock = dockAfterDrag(drop, screen);
  assert.equal(dock?.side, 'top');
  assert.equal(dock?.displayId, screen.id);
  assert.ok(dock);
  assert.deepEqual(dockBounds(screen.workArea, dock, 88, true), { x: -788, y: 24, width: 144, height: 44 });
  assert.deepEqual(dockBounds(screen.workArea, dock, 88, false), drop);
});

test('side docks align the compact handle to either edge and keep it in the work area', () => {
  const free = { x: -1440, y: 426, width: 368, height: 88 };
  const left = dockAfterDrag(free, screen);
  assert.ok(left);
  assert.equal(left.side, 'left');
  assert.deepEqual(dockBounds(screen.workArea, left, 88, true),
    { x: -1440, y: 415, width: 44, height: 110 });

  const right = dockAfterDrag({ ...free, x: -368 }, screen);
  assert.ok(right);
  assert.equal(right.side, 'right');
  assert.deepEqual(dockBounds(screen.workArea, { ...right, offset: 1 }, 88, true),
    { x: -44, y: 790, width: 44, height: 110 });
});

test('drop distance supports detaching and does not activate the bottom edge', () => {
  const nearLeft = { x: -1425, y: 400, width: 368, height: 88 };
  const left = dockAfterDrag({ ...nearLeft, x: -1440 }, screen);
  assert.ok(left);
  assert.equal(dockAfterDrag(nearLeft, screen), undefined);
  assert.equal(dockAfterDrag(nearLeft, screen, left)?.side, 'left');
  assert.equal(dockAfterDrag({ ...nearLeft, x: -1395 }, screen, left), undefined);
  assert.equal(dockAfterDrag({ ...nearLeft, x: -935, y: 812 }, screen), undefined);
});
