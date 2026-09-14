const fs = require('fs');
try {
  new Function(fs.readFileSync('app.js', 'utf8'));
  console.log('Syntax OK');
} catch (e) {
  console.error(e);
}
