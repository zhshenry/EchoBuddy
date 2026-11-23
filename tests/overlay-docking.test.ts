import assert from 'node:assert/strict';
import test from 'node:test';
import { dockAfterDrag, dockBounds, dockWindowLayout } from '../electron/overlay-position';

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

test('a compact top bar stays on the top edge while sliding to a corner and can be pulled off', () => {
  const previous = { side: 'top', displayId: screen.id, offset: .5 } as const;
  const drop = { x: -1440, y: 24, width: 144, height: 44 };
  const dock = dockAfterDrag(drop, screen, previous, true);
  assert.ok(dock);
  assert.equal(dock.side, 'top');
  assert.deepEqual(dockBounds(screen.workArea, dock, 88, true), drop);
  assert.equal(dockAfterDrag({ ...drop, x: -1080, y: 73 }, screen, previous, true), undefined);
});

test('a compact side bar keeps its dropped vertical position without the expanded gutter', () => {
  const previous = { side: 'right', displayId: screen.id, offset: .5 } as const;
  const drop = { x: -44, y: 380, width: 44, height: 110 };
  const dock = dockAfterDrag(drop, screen, previous, true);
  assert.ok(dock);
  assert.equal(dock.side, 'right');
  assert.deepEqual(dockBounds(screen.workArea, dock, 88, true), drop);
});

test('both dock poses preserve their screen positions inside a single native frame', () => {
  const { workArea } = screen;
  for (const side of ['left', 'right', 'top'] as const) {
    const placement = { side, displayId: screen.id, offset: .5 };
    const { frame, compact, expanded } = dockWindowLayout(workArea, placement, 88);
    for (const [bounds, isCompact] of [[compact, true], [expanded, false]] as const) {
      assert.ok(bounds.x >= 0 && bounds.y >= 0);
      assert.ok(bounds.x + bounds.width <= frame.width && bounds.y + bounds.height <= frame.height);
      assert.deepEqual({ ...bounds, x: frame.x + bounds.x, y: frame.y + bounds.y },
        dockBounds(workArea, placement, 88, isCompact));
    }
  }
});
