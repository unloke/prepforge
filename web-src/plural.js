// "1 game" / "3 games". `many` defaults to singular + "s".
export function countOf(n, one, many = `${one}s`) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}
