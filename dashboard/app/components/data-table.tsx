import { ReactNode } from "react";

export type Column<T> = {
  key: string;
  label: string;
  align?: "left" | "right";
  mono?: boolean;
  render: (row: T) => ReactNode;
};

/**
 * Generic table: hairline rows (bottom borders only, one weight),
 * sticky header, tabular numerals in numeric columns, horizontal
 * scroll on narrow viewports instead of crushed columns.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty = "No rows to show.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-3">{empty}</p>;
  }

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`sticky top-0 whitespace-nowrap bg-surface px-3 py-2 text-xs font-medium ${
                  c.align === "right" ? "text-right" : "text-left"
                } text-ink-3`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line/60 last:border-b-0 hover:bg-surface-2/40">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`whitespace-nowrap px-3 py-2 ${
                    c.align === "right" ? "text-right tnum" : c.mono ? "tnum" : ""
                  } text-ink-2`}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
