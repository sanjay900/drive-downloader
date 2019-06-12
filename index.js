const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const PromisePool = require('es6-promise-pool');
const Streamspeed = require('streamspeed');
const hasha = require('hasha');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = 'token.json';

// Load client secrets from a local file.
fs.readFile('credentials.json', (err, content) => {
  if (err) return console.log('Error loading client secret file:', err);
  // Authorize a client with credentials, then call the Google Drive API.
  authorize(JSON.parse(content), listFiles);
});

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client =
      new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getAccessToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getAccessToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

/**
 * Lists the names and IDs of up to 10 files.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
async function listFiles(auth) {
  const drive = google.drive({version: 'v3', auth});
  let fileId = '0B7H6hIZDxNXeQW9uODA5UkM0ZG8';
  let files = [];
  let token;
  //get all files
  do {
    let res = await drive.files.list({
        includeRemoved: false,
        spaces: 'drive',
        fileId: fileId,
        pageToken: token,
        fields: 'nextPageToken, files(id, name, parents, md5Checksum, size)',
        q: `'${fileId}' in parents`
      });
      files.push(...res.data.files);
      token = res.data.nextPageToken;
      console.log("Files found: "+files.length);
  } while (token);
  //download 2 files at a time
  const parallelCount = 2;
  const total = files.length;
  const currentFiles = [];
  let downloaded = 0;
  //logging
  setInterval(() => {
    console.log('Files Downloaded: ' + (total - files.length) + ' / ' + total);
    for (let file of currentFiles) {
      console.log(file.name + ' - ' + file.progress);
    }
  }, 500);
  if (files.length) {
    let producer = () => {
      if (files.length) {
        return copyFile(drive, files.shift(), currentFiles);
      }
      return null;
    };
    //use the producer until it runs out 
    await new PromisePool(producer, parallelCount).start();
  } else {
    console.log('No files found.');
  }
}
async function copyFile(drive, f, currentFiles, speed) {
  let fileInfo = {name: f.name, progress: '0%'};
  currentFiles.push(fileInfo);
  //the temp folder in my drive
  var body = {'parents': ['1ZRLBag9O9HsOXZdbJKQ8UbA9L9yKiv0m']};
  let fileName = '/media/HDD/downloads/Wii/' + f.name;
  let progress = 0;
  let myDriveId;
  let updating = fs.existsSync(fileName) && fs.statSync(fileName).size != f.size;
  while (true) {
    if (!fs.existsSync(fileName) ||
        (progress = fs.statSync(fileName).size) != f.size) {
      fileInfo.progress = (progress / f.size * 100).toFixed(2) + '%';
      //check if the file already exists on the drive (for resuming downloads.) escape ' to \'
      myDriveId = await drive.files.list({
        'fileId': f.id,
        'q': `parents='${body.parents}' and name='${f.name.replace("'","\\'")}'`
      });
      if (myDriveId.data.files.length > 0) {
        myDriveId = myDriveId.data.files[0].id;
      } else {
          //copy from origin to my drive for getting around quota
        myDriveId =
            (await drive.files.copy({'fileId': f.id, 'requestBody': body}))
                .data.id;
      }
      var dest = fs.createWriteStream(fileName, {flags: 'a'});
      await new Promise((resolve, reject) => {
          //Resume partial downloads by sending a range header
        drive.files.get(
            {
              fileId: myDriveId,
              alt: 'media',
              headers: {Range: `bytes=${progress}-${f.size}`}
            },
            {responseType: 'stream'}, function(err, response) {
              response.data.on('error', reject)
                  .on('end', resolve)
                  .on('data',
                      buffer => {
                        progress += buffer.length;
                        fileInfo.progress =
                            (progress / f.size * 100).toFixed(2) + '%';
                      })
                  .pipe(dest);
            });
      });
    }
    //If a file is resumed, check it is downloaded correctly. i would do this every file but its slow.
    if (!updating) break;
    fileInfo.progress = 'Checking File (0%)';
    let checkProgress = 0;
    let st = fs.createReadStream(fileName, {highWaterMark: 1024 * 1024 * 2});
    st.on('data', chunk => {
      checkProgress += chunk.length;
      fileInfo.progress =
          'Checking File ' + (checkProgress / f.size * 100).toFixed(2) + '%)';
    })
    if (f.md5Checksum == await hasha.fromStream(st, {algorithm: 'md5'})) {
      break;
    }
    //File is corrupt, start again
    fs.unlinkSync(fileName);
    progress = 0;
  }
  myDriveId && await drive.files.delete({fileId: myDriveId});
  currentFiles.splice(currentFiles.indexOf(fileInfo), 1);
  return;
}