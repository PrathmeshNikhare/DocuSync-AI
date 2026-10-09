// Liveness only: proves the app serves requests. It does not check the database or model.
export function GET() {
  return Response.json({ status: "ok" });
}
