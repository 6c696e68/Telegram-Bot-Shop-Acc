import bcrypt from 'bcryptjs'
const pw = process.argv[2]
if (!pw) { console.error('Usage: node test/hash_password.js <password>'); process.exit(1) }
console.log(await bcrypt.hash(pw, 10))
