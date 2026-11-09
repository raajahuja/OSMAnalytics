// Decides which place names fit on the map without covering each other.
export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CELL_SIZE = 128;
const CHARACTER_WIDTH = 5.6;
const LABEL_PADDING = 8;

export const labelWidth = (text: string) =>
  text.length * CHARACTER_WIDTH + LABEL_PADDING;

export const rankPriority = (rank?: string) =>
  rank === "city" ? 0 : rank === "town" ? 1 : 2;

function overlaps(a: LabelBox, b: LabelBox) {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2
  );
}

// Boxes are centred on x and y and given most important first. Earlier boxes win.
export function visibleLabels(boxes: LabelBox[]): boolean[] {
  const grid = new Map<string, LabelBox[]>();
  const cellsFor = (box: LabelBox) => {
    const keys: string[] = [];
    const lastColumn = Math.floor((box.x + box.width / 2) / CELL_SIZE);
    const lastRow = Math.floor((box.y + box.height / 2) / CELL_SIZE);
    for (let column = Math.floor((box.x - box.width / 2) / CELL_SIZE); column <= lastColumn; column++)
      for (let row = Math.floor((box.y - box.height / 2) / CELL_SIZE); row <= lastRow; row++)
        keys.push(column + ":" + row);
    return keys;
  };
  return boxes.map((box) => {
    const keys = cellsFor(box);
    if (keys.some((key) => grid.get(key)?.some((other) => overlaps(box, other))))
      return false;
    for (const key of keys) {
      const cell = grid.get(key);
      if (cell) cell.push(box);
      else grid.set(key, [box]);
    }
    return true;
  });
}
