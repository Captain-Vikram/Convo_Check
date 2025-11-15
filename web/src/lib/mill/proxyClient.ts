/**
 * Lightweight client to forward requests from the Next web app to the Mill service.
 * Expects MILL_API_BASE_URL and MILL_SERVICE_TOKEN to be set in environment.
 */

export async function callMillProcessMessage(payload: unknown): Promise<any> {
  const base = process.env.MILL_API_BASE_URL;
  const token = process.env.MILL_SERVICE_TOKEN;

  if (!base) {
    throw new Error("MILL_API_BASE_URL is not configured");
  }

  const url = `${base.replace(/\/$/, "")}/process-message`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? `Bearer ${token}` : "",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  try {
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = (json && json.error) || res.statusText || text;
      throw new Error(`Mill responded ${res.status}: ${err}`);
    }
    return json;
  } catch (err) {
    // If parsing fails and status is OK, return raw text
    if (res.ok) return text;
    throw err;
  }
}

export default callMillProcessMessage;
