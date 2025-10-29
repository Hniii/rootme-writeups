
1. Load the challenge page in Chrome or Firefox.
2. Open DevTools (`F12`).

### Enable source maps 
DevTools → Settings (gear) → **Sources** → enable:
- “Enable JavaScript source maps”
- “Enable CSS source maps”
## Find the main JS bundle
1. DevTools → **Network** tab.
2. Reload the page (`Ctrl+R`).    
3. Filter by **JS**.
4. Locate themain bundle (`app.<hash>.js` or similar).
5. Click that request and copy the **Request URL** (exact).
Example:
## Locate the sourceMap name

![[Pasted image 20251028143050.png]]
![[Pasted image 20251028143416.png]]
