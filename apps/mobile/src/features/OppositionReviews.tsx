import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { OppositionReviewCommand, OppositionReviewGame, OppositionReviewView } from '@longball/application/opposition-review';
import { formatUkDate } from '@longball/application/uk-display';
import { randomUUID } from '../platform/id';
import { Button, Card, Notice, colors, typography } from '../ui';

export function OppositionReviews({value,busy=false,error,onSave}: {
  value:OppositionReviewView;
  busy?:boolean;
  error?:string|null;
  onSave?:(command:OppositionReviewCommand)=>Promise<boolean>;
}) {
  const [selected,setSelected]=useState<string|null>(null);
  const game=value.games.find(item=>item.matchId===selected)??value.games[0];
  return <View style={styles.stack} testID="opposition-reviews">
    <Text style={typography.title}>Opposition notes</Text>
    <Text style={typography.body}>Manager capability ratings and notes for future games. Team players can read these; spectators cannot.</Text>
    {error&&<Notice tone="error">{error}</Notice>}
    {!game?<Notice>Notes become available when a game has a recorded completed result.</Notice>:<>
      <View style={styles.choices}>{value.games.map(item=><Button key={item.matchId} label={`${item.opponent} · ${formatUkDate(item.playedDate)}`} compact variant={game.matchId===item.matchId?'primary':'secondary'} onPress={()=>setSelected(item.matchId)} disabled={busy}/>)}</View>
      <OppositionReviewDraft key={`${value.teamId}:${value.seasonId}:${game.matchId}:${game.review?.revision??0}`} game={game} canEdit={value.canEdit&&Boolean(onSave)} busy={busy} onSave={onSave}/>
    </>}
  </View>;
}
function OppositionReviewDraft({game,canEdit,busy,onSave}: {game:OppositionReviewGame;canEdit:boolean;busy:boolean;onSave?: (command:OppositionReviewCommand)=>Promise<boolean>}) {
  const [rating,setRating]=useState<number|null>(game.review?.rating??null),[note,setNote]=useState(game.review?.note??''),[saving,setSaving]=useState(false);
  const disabled=busy||saving;
  return <Card>
    <Text style={typography.section}>{game.opponent}</Text>
    <Text style={typography.muted}>{formatUkDate(game.playedDate)}</Text>
    <Text style={typography.label}>Opposition capability · 1 to 5</Text>
    {canEdit?<>
      <View accessibilityRole="radiogroup" accessibilityLabel="Opposition capability rating" style={styles.choices}>
        {[1,2,3,4,5].map(choice=><Pressable key={choice} accessibilityRole="radio" accessibilityLabel={`Opposition capability ${choice} out of 5`} accessibilityState={{checked:rating===choice,disabled}} disabled={disabled} testID={`opposition-rating-${choice}`} onPress={()=>setRating(choice)} style={[styles.rating,rating===choice&&styles.chosen]}><Text style={[typography.section,rating===choice&&styles.chosenText]}>{choice}</Text></Pressable>)}
      </View>
      <Text style={typography.label}>Note (optional)</Text>
      <TextInput accessibilityLabel="Opposition note" testID="opposition-note" editable={!disabled} multiline value={note} maxLength={512} onChangeText={text=>setNote(Array.from(text).slice(0,256).join(''))} style={styles.input}/>
      <Text style={typography.muted}>{Array.from(note).length}/256</Text>
      <Button label="Save opposition notes" disabled={disabled||rating===null} testID="opposition-save" onPress={()=>{if(rating===null||!onSave)return;setSaving(true);void onSave({id:randomUUID(),type:'opposition.review.saved',matchId:game.matchId,expectedRevision:game.review?.revision??0,rating,note:note.trim()||null}).finally(()=>setSaving(false));}}/>
    </>:game.review?<><Text style={typography.body}>{game.review.rating}/5</Text>{game.review.note&&<Text style={typography.body}>{game.review.note}</Text>}</>:<Text style={typography.muted}>No opposition review recorded yet.</Text>}
  </Card>;
}
const styles=StyleSheet.create({stack:{gap:12},choices:{flexDirection:'row',flexWrap:'wrap',gap:8},rating:{minHeight:48,minWidth:48,borderRadius:8,borderWidth:2,borderColor:colors.controlBorder,alignItems:'center',justifyContent:'center',padding:8},chosen:{backgroundColor:colors.brand,borderColor:colors.brand},chosenText:{color:colors.surface},input:{...typography.body,minHeight:96,padding:12,borderWidth:1,borderColor:colors.controlBorder,borderRadius:8,textAlignVertical:'top'}});
