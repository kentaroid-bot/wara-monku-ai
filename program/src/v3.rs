// Devnet v0.3. Community accounts are immutable issuers. Legacy configs never qualify.
use super::*;
const GROUP:u8=31;
const SHOP:u8=32;
const MEMBER:u8=33;
const ALLY:u8=34;
const WALLET:u8=35;
const LIMIT:u64=10;
const OFFSET:i64=32400;

fn pda(program:&Pubkey,seeds:&[&[u8]],account:&AccountInfo)->Result<u8,ProgramError>{
 let (id,bump)=Pubkey::find_program_address(seeds,program); require(id==*account.key,5)?;Ok(bump)
}
fn group<'a>(g:&AccountInfo<'a>,program:&Pubkey)->Result<(Pubkey,u8,Pubkey),ProgramError>{
 require(g.owner==program,5)?;let d=g.try_borrow_data()?;
 require(d.len()>66&&d[0]==GROUP,5)?;
 Ok((Pubkey::new_from_array(d[1..33].try_into().unwrap()),d[33],Pubkey::new_from_array(d[34..66].try_into().unwrap())))
}
fn ensure_pda<'a>(program:&Pubkey,payer:&AccountInfo<'a>,account:&AccountInfo<'a>,sys:&AccountInfo<'a>,seeds:&[&[u8]],len:usize)->ProgramResult{
 let bump=[pda(program,seeds,account)?];
 if account.owner!=program {let mut full=seeds.to_vec();full.push(&bump);create_pda(payer,account,sys,program,len,&full)?;}
 require(account.owner==program && account.data_len()==len,5)
}
fn edge_set<'a>(program:&Pubkey,payer:&AccountInfo<'a>,row:&AccountInfo<'a>,sys:&AccountInfo<'a>,prefix:&[u8],tag:u8,from:&Pubkey,to:&Pubkey,status:u8)->ProgramResult{
 ensure_pda(program,payer,row,sys,&[prefix,from.as_ref(),to.as_ref()],66)?;
 let mut d=row.try_borrow_mut_data()?;
 d[0]=tag;d[1..33].copy_from_slice(from.as_ref());d[33..65].copy_from_slice(to.as_ref());d[65]=status;Ok(())
}
fn edge_is(program:&Pubkey,row:&AccountInfo,prefix:&[u8],tag:u8,from:&Pubkey,to:&Pubkey,status:u8)->ProgramResult{
 pda(program,&[prefix,from.as_ref(),to.as_ref()],row)?;
 require(row.owner==program && row.data_len()==66,5)?;let d=row.try_borrow_data()?;
 require(d[0]==tag&&d[65]==status,5)
}
fn shop(program:&Pubkey,row:&AccountInfo,g:&Pubkey,merchant:&Pubkey)->ProgramResult{
 pda(program,&[b"s3",g.as_ref(),merchant.as_ref()],row)?;require(row.owner==program&&row.data_len()>65&&row.try_borrow_data()?[0]==SHOP,5)
}
pub fn process(program:&Pubkey,accounts:&[AccountInfo],op:u8,rest:&[u8])->ProgramResult{
 let mut it=accounts.iter();let who=next_account_info(&mut it)?;signer(who)?;
 let g=next_account_info(&mut it)?;
 if op==10 {
  // mode + invite verification public key + UTF-8 display metadata.
  require(rest.len()>33&&rest.len()<=433&&rest[0]<=2&&std::str::from_utf8(&rest[33..]).is_ok(),5)?;
  let mint=next_account_info(&mut it)?;let sys=next_account_info(&mut it)?;let token=next_account_info(&mut it)?;
  signer(g)?;require(g.owner==program&&g.data_len()==33+rest.len()&&g.try_borrow_data()?.iter().all(|b|*b==0),5)?;
  let bump=pda(program,&[b"w3",g.key.as_ref()],mint)?;require(*token.key==spl_token::id(),5)?;
  create_pda(who,mint,sys,token.key,Mint::LEN,&[b"w3",g.key.as_ref(),&[bump]])?;
  // The mint is also its signing PDA; it belongs to SPL Token.
  invoke(&spl_token::instruction::initialize_mint2(token.key,mint.key,mint.key,None,0)?,&[mint.clone(),token.clone()])?;
  let mut d=g.try_borrow_mut_data()?;d[0]=GROUP;d[1..33].copy_from_slice(who.key.as_ref());d[33..].copy_from_slice(rest);return Ok(())
 }
 let (owner,mode,invite)=group(g,program)?;
 match op {
  11=>{ // certify shop
   let merchant=next_account_info(&mut it)?;let row=next_account_info(&mut it)?;let sys=next_account_info(&mut it)?;
   require(*who.key==owner&&!rest.is_empty()&&rest.len()<=120&&std::str::from_utf8(rest).is_ok(),5)?;
   let bump=pda(program,&[b"s3",g.key.as_ref(),merchant.key.as_ref()],row)?;
   create_pda(who,row,sys,program,65+rest.len(),&[b"s3",g.key.as_ref(),merchant.key.as_ref(),&[bump]])?;
   let mut d=row.try_borrow_mut_data()?;d[0]=SHOP;d[1..33].copy_from_slice(g.key.as_ref());d[33..65].copy_from_slice(merchant.key.as_ref());d[65..].copy_from_slice(rest);Ok(())
  },
  12=>{ // self joins (open/invitation) or requests entry; founder may approve a pending request.
   let user=next_account_info(&mut it)?;let row=next_account_info(&mut it)?;let sys=next_account_info(&mut it)?;
   require(rest.len()==1,5)?;
   let status=if rest[0]==1{
    require(*who.key==owner&&mode==2,5)?;edge_is(program,row,b"m3",MEMBER,g.key,user.key,1)?;2
   }else{
    require(rest[0]==0&&who.key==user.key&&row.owner!=program,5)?;
    if mode==1 {let code=next_account_info(&mut it)?;signer(code)?;require(*code.key==invite,5)?;}
    if mode==2{1}else{2}
   };
   edge_set(program,who,row,sys,b"m3",MEMBER,g.key,user.key,status)
  },
  13=>{ // outgoing offer; approval requires the other owner's signature on its own offer.
   let other=next_account_info(&mut it)?;group(other,program)?;
   let row=next_account_info(&mut it)?;let sys=next_account_info(&mut it)?;
   require(*who.key==owner&&g.key!=other.key&&rest.len()==1&&rest[0]<=1,5)?;
   edge_set(program,who,row,sys,b"a3",ALLY,g.key,other.key,rest[0])
  },
  14=>{
   require(rest.len()==24,5)?;
   let n=u64::from_le_bytes(rest[0..8].try_into().unwrap());
   let day=i64::from_le_bytes(rest[8..16].try_into().unwrap());let nonce=u64::from_le_bytes(rest[16..24].try_into().unwrap());
   let now=(Clock::get()?.unix_timestamp.checked_add(OFFSET).ok_or(err(1))?).div_euclid(86400);
   require(now==day,1)?;require(n>0&&n<=LIMIT,4)?;
   let merchant=next_account_info(&mut it)?;let shop_row=next_account_info(&mut it)?;let member=next_account_info(&mut it)?;
   let person=next_account_info(&mut it)?;let mint=next_account_info(&mut it)?;let dst=next_account_info(&mut it)?;let refund=next_account_info(&mut it)?;
   let sys=next_account_info(&mut it)?;let token=next_account_info(&mut it)?;
   require(who.key!=merchant.key,6)?;shop(program,shop_row,g.key,merchant.key)?;
   if *who.key!=owner{edge_is(program,member,b"m3",MEMBER,g.key,who.key,2)?;}
   ensure_pda(program,who,person,sys,&[b"p3",who.key.as_ref()],25)?;
   let bump=pda(program,&[b"w3",g.key.as_ref()],mint)?;
   require(*token.key==spl_token::id()&&mint.owner==token.key,5)?;
   for (a,expected) in [(dst,merchant.key),(refund,who.key)]{
    require(a.owner==token.key,5)?;let ac=TokenAccount::unpack(&a.try_borrow_data()?)?;require(ac.mint==*mint.key&&ac.owner==*expected,5)?;
   }
   {let mut d=person.try_borrow_mut_data()?;let last=i64::from_le_bytes(d[1..9].try_into().unwrap());
    require(now>=last,7)?;let old=if now==last{u64::from_le_bytes(d[9..17].try_into().unwrap())}else{0};
    require(nonce==u64::from_le_bytes(d[17..25].try_into().unwrap()),3)?;
    let spent=old.checked_add(n).ok_or(err(2))?;require(spent<=LIMIT,2)?;
    d[0]=WALLET;d[1..9].copy_from_slice(&now.to_le_bytes());d[9..17].copy_from_slice(&spent.to_le_bytes());
    d[17..25].copy_from_slice(&nonce.checked_add(1).ok_or(err(3))?.to_le_bytes());}
   for (account,rate) in [(dst,90),(refund,10)]{
    invoke_signed(&spl_token::instruction::mint_to_checked(token.key,mint.key,account.key,mint.key,&[],n*rate,0)?,
      &[mint.clone(),account.clone(),token.clone()],&[&[b"w3",g.key.as_ref(),&[bump]]])?;
   }
   solana_program::msg!("WARA v3 Kusa payment; issuer:");g.key.log();Ok(())
  },
  15=>{ // A register rechecks acceptance on-chain at transfer execution.
   let origin=next_account_info(&mut it)?;group(origin,program)?;
   let merchant=next_account_info(&mut it)?;let store=next_account_info(&mut it)?;shop(program,store,g.key,merchant.key)?;
   require(rest.len()==8&&who.key!=merchant.key,5)?;let n=u64::from_le_bytes(rest.try_into().unwrap());require(n>0,4)?;
   if g.key!=origin.key{
    edge_is(program,next_account_info(&mut it)?,b"a3",ALLY,g.key,origin.key,1)?;
    edge_is(program,next_account_info(&mut it)?,b"a3",ALLY,origin.key,g.key,1)?;
   }
   let mint=next_account_info(&mut it)?;pda(program,&[b"w3",origin.key.as_ref()],mint)?;
   let src=next_account_info(&mut it)?;let dst=next_account_info(&mut it)?;let token=next_account_info(&mut it)?;
   require(*token.key==spl_token::id()&&dst.owner==token.key&&src.owner==token.key,5)?;
   for(a,w)in[(src,who.key),(dst,merchant.key)]{let d=TokenAccount::unpack(&a.try_borrow_data()?)?;require(d.owner==*w&&d.mint==*mint.key,5)?;}
   invoke(&spl_token::instruction::transfer_checked(token.key,src.key,mint.key,dst.key,who.key,&[],n,0)?,&[src.clone(),mint.clone(),dst.clone(),who.clone(),token.clone()])
  },
  _=>Err(ProgramError::InvalidInstructionData)
 }
}
