
The website prompts us to enter a password.

Let's check the source code.

![[Pasted image 20251028144148.png]]
The password is string is obfuscated to hexadecimal.

We can use the `String.fromCharCode()` function in `Developer tools > Console` to convert the hexadecimal character into string.

![[Pasted image 20251028144105.png]]
