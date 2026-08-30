---
name: Gemini model availability
description: The workspace Gemini credential may reject older text models even when the SDK supports them.
---

Use a currently enabled model returned by the provider rather than assuming an older Gemini model remains available to new users. In this workspace, the credential rejected Gemini 2.5 Flash and accepted Gemini 3.6 Flash.

**Why:** The provider returned a 404 saying the older model was no longer available to new users.

**How to apply:** If a Gemini request returns a model-availability 404, update the configured model to the provider-recommended current text model and rerun a small structured-output request.