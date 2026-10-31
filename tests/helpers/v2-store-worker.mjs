import { DatabaseSync } from 'node:sqlite';
import { openDatabase, prepareDatabaseRoot, processStamp } from '../../integrations/session-metadata/src/database.mjs';
import { saveComment, claimSubmission } from '../../integrations/session-metadata/src/plans/reviews.mjs';

const root = process.argv[2], mode = process.argv[3];
if (mode === 'incomplete') {
  const {path} = prepareDatabaseRoot({root});
  const sql = new DatabaseSync(path);
  sql.exec('BEGIN IMMEDIATE; CREATE TABLE unfinished (value TEXT);');
  process.send({event:'opened'});
  setInterval(() => {}, 1000);
} else {
  const db = openDatabase({root});
  const actor = {pid:process.pid, startedAt:processStamp(process.pid)};
  process.on('message', message => {
    if (message?.claimSubmission && mode==='submission') process.send({event:'claimed',value:claimSubmission(message.claimSubmission,actor,db)});
    if (message?.save && mode==='comment') {
      try {process.send({event:'saved',value:saveComment(message.save,db)});}catch(e){process.send({event:'saved',error:e.message});}
    }
    if (message === 'claim') process.send({event:'claim', value:db.claim('shared-resource', actor)});
    if (message?.release) process.send({event:'released', value:db.release('shared-resource', message.release)});
    if (message === 'close') { db.close(); process.exit(0); }
  });
  process.send({event:'ready', actor});
}
