'use strict';
// Fake Nigerian bank alerts in many shapes (GTBank, Access, Zenith, UBA, Opay, Kuda, Moniepoint, Sterling, FirstBank, ALAT style).
// Every name, number and account here is made up. The formats are the point.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInput } = require('../lib/ingest');

const CASES = [
 {
  "label": "GTBank SMS compact",
  "text": "GTBank: Acct:012***890 Amt:NGN5,000.00 DR Desc:POS/WEB PMT NETFLIX.COM Date:29-Oct-2026 Bal:NGN123,456.78 CR",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "NETFLIX",
    "balance": 123456.78
   }
  ]
 },
 {
  "label": "GTBank email block",
  "text": "Transaction Alert [Debit]\nDear CHUKWUDI,\nWe wish to inform you that a Debit transaction occurred on your account with us.\nAccount Number: 012****890\nTransaction Location: GTWorld\nDescription: POS/WEB PMT SPOTIFY\nAmount: NGN 2,300.00\nValue Date: 29/10/2026\nRemarks: SPOTIFY P3A\nTime of Transaction: 10:52 AM\nDocument Number: 0000123456\nCurrent Balance: NGN 98,765.43\nAvailable Balance: NGN 98,765.43",
  "exp": [
   {
    "amount": 2300,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "10:52",
    "desc": "SPOTIFY"
   }
  ]
 },
 {
  "label": "GTBank credit email",
  "text": "Transaction Alert [Credit]\nAccount Number: 012****890\nDescription: NIP/TRF FROM ADAEZE OKOYE\nAmount: NGN 45,000.00\nValue Date: 28/10/2026\nTime of Transaction: 03:11 PM\nCurrent Balance: NGN 143,765.43",
  "exp": [
   {
    "amount": 45000,
    "direction": "credit",
    "date": "2026-10-28",
    "time": "15:11",
    "desc": "ADAEZE"
   }
  ]
 },
 {
  "label": "Access SMS",
  "text": "Debit Alert\nAmt:NGN5,000.00\nAcc:012****789\nDes:NIP/TRF TO BOLA ADE\nDate:29-OCT-26\nBal:NGN11,000.00\nDial *901# for more",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "BOLA",
    "balance": 11000
   }
  ]
 },
 {
  "label": "Access credit SMS one line",
  "text": "Credit Alert! Amt:NGN150,000.00 Acc:012****789 Des:SALARY OCT 2026 DANGOTE Date:28-OCT-26 Bal:NGN161,000.00",
  "exp": [
   {
    "amount": 150000,
    "direction": "credit",
    "date": "2026-10-28",
    "desc": "SALARY"
   }
  ]
 },
 {
  "label": "Zenith SMS",
  "text": "Txn:Debit Acct:1012***678 Amt:NGN 3,750.00 Narr:POS TXN SHOPRITE LEKKI Date:29OCT26 Time:14:05 Avail Bal:NGN 54,210.50",
  "exp": [
   {
    "amount": 3750,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "14:05",
    "desc": "SHOPRITE",
    "balance": 54210.5
   }
  ]
 },
 {
  "label": "Zenith slash date",
  "text": "Zenith Bank Transaction Alert: Acct:1012***678 Amt:NGN12,000.00 DR Desc:ATM WDL ABUJA Date:29/10/2026 Bal:NGN42,210.50",
  "exp": [
   {
    "amount": 12000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "ATM"
   }
  ]
 },
 {
  "label": "UBA SMS",
  "text": "UBA Alert: Debit NGN5,000.00 Acct:2***1234 Narr:USSD TRANSFER TO KEMI BELLO Date:29-OCT-2026 Bal:NGN 20,100.00",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "KEMI"
   }
  ]
 },
 {
  "label": "UBA txn style",
  "text": "Txn: Debit\nAcct: 2***1234\nAmt: NGN 1,200.00\nDesc: AIRTIME PURCHASE MTN\nDate: 29-Oct-2026\nTime: 21:47:10\nAvail Bal: NGN 18,900.00",
  "exp": [
   {
    "amount": 1200,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "21:47",
    "desc": "AIRTIME"
   }
  ]
 },
 {
  "label": "Opay sent",
  "text": "Transfer Successful\n₦5,000.00\nTo: CHIOMA OKAFOR | 0123456789 (GTBank)\n2026-10-29 14:05:33",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "14:05",
    "desc": "CHIOMA"
   }
  ]
 },
 {
  "label": "Opay received",
  "text": "You have received ₦12,500.00 from EMEKA NWOSU on Oct 29th, 2026, 08:14 AM. Balance: ₦30,200.00",
  "exp": [
   {
    "amount": 12500,
    "direction": "credit",
    "date": "2026-10-29",
    "time": "08:14",
    "desc": "EMEKA",
    "balance": 30200
   }
  ]
 },
 {
  "label": "Opay airtime",
  "text": "OPay: You bought ₦500.00 airtime for 0803***4567 on 29-10-2026 22:31. Bal: ₦9,800.00",
  "exp": [
   {
    "amount": 500,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "22:31",
    "desc": "airtime"
   }
  ]
 },
 {
  "label": "Kuda sent",
  "text": "Kuda: You sent ₦2,000.00 to ADA OBI on 29 Oct 2026 at 11:20 PM. Your balance is now ₦6,540.25",
  "exp": [
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "23:20",
    "desc": "ADA",
    "balance": 6540.25
   }
  ]
 },
 {
  "label": "Kuda received",
  "text": "You've received ₦75,000.00 from ACME LTD SALARY. 28 Oct 2026 09:00 AM. Balance ₦81,540.25",
  "exp": [
   {
    "amount": 75000,
    "direction": "credit",
    "date": "2026-10-28",
    "time": "09:00",
    "desc": "ACME"
   }
  ]
 },
 {
  "label": "Kuda debit minus",
  "text": "Kuda Debit Alert: -₦850.00 | Spend: CHICKEN REPUBLIC | 2026-10-29 13:02 | Balance ₦5,690.25",
  "exp": [
   {
    "amount": 850,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "13:02",
    "desc": "CHICKEN"
   }
  ]
 },
 {
  "label": "Moniepoint pipe",
  "text": "Moniepoint: Debit | NGN 2,000.00 | Acct: 80****123 | Desc: POS PURCHASE BUKKA HUT | 29/10/2026 18:45 | Bal: NGN 3,100.00",
  "exp": [
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "18:45",
    "desc": "BUKKA",
    "balance": 3100
   }
  ]
 },
 {
  "label": "Moniepoint sentence",
  "text": "Dear TUNDE, your account has been debited with NGN 5,000.00 on 29/10/2026 14:05. Narration: NIP TRANSFER TO JOY. Balance: NGN 8,000.00",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "JOY",
    "balance": 8000
   }
  ]
 },
 {
  "label": "Moniepoint credit",
  "text": "Moniepoint Credit Alert: NGN 20,000.00 received from SAMUEL ADEBAYO. Ref 000013261029140533. 29-10-2026 09:12. Balance NGN 28,000.00",
  "exp": [
   {
    "amount": 20000,
    "direction": "credit",
    "date": "2026-10-29",
    "desc": "SAMUEL"
   }
  ]
 },
 {
  "label": "No space N amount, no decimals",
  "text": "Debit Alert: N5000 at POS/MARKET SQUARE Date:29/10/26 Bal:N12000",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "MARKET"
   }
  ]
 },
 {
  "label": "Currency after amount",
  "text": "Debit Alert Amt:5,000.00 NGN Desc:WEB PMT JUMIA Date:29-Oct-2026 Bal:20,000.00 NGN",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "JUMIA"
   }
  ]
 },
 {
  "label": "Fee line with charge in same alert",
  "text": "GTBank: Acct:012***890 Amt:NGN10.75 DR Desc:SMS ALERT CHARGE Date:29-Oct-2026 Bal:NGN100.00",
  "exp": [
   {
    "amount": 10.75,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "SMS"
   }
  ]
 },
 {
  "label": "Alerts glued with no blank lines",
  "text": "Debit Alert Amt:NGN1,000.00 Acc:012****789 Des:POS/BOLT RIDE Date:27-OCT-26 Bal:NGN9,000.00\nDebit Alert Amt:NGN2,000.00 Acc:012****789 Des:POS/BOLT RIDE Date:28-OCT-26 Bal:NGN7,000.00\nDebit Alert Amt:NGN3,000.00 Acc:012****789 Des:POS/BOLT RIDE Date:29-OCT-26 Bal:NGN4,000.00",
  "exp": [
   {
    "amount": 1000,
    "direction": "debit",
    "date": "2026-10-27"
   },
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-28"
   },
   {
    "amount": 3000,
    "direction": "debit",
    "date": "2026-10-29"
   }
  ]
 },
 {
  "label": "Multi-line alerts glued no blank lines",
  "text": "Debit Alert\nAmt:NGN1,000.00\nDes:POS/BOLT RIDE\nDate:27-OCT-26\nBal:NGN9,000.00\nDebit Alert\nAmt:NGN2,000.00\nDes:POS/BOLT RIDE\nDate:28-OCT-26\nBal:NGN7,000.00",
  "exp": [
   {
    "amount": 1000,
    "direction": "debit",
    "date": "2026-10-27"
   },
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-28"
   }
  ]
 },
 {
  "label": "Forwarded quoted email",
  "text": "> From: GTBank <noreply@gtbank.example>\n> Subject: GTBank Transaction Alert\n>\n> Transaction Alert [Debit]\n> Description: POS/WEB PMT NETFLIX.COM\n> Amount: NGN 4,500.00\n> Value Date: 29/10/2026\n> Time of Transaction: 02:14 AM\n> Current Balance: NGN 10,000.00",
  "exp": [
   {
    "amount": 4500,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "02:14",
    "desc": "NETFLIX"
   }
  ]
 },
 {
  "label": "Phone copy with timestamps between",
  "text": "Oct 29, 2026 at 2:14 AM\nGTBank: Acct:012***890 Amt:NGN4,500.00 DR Desc:NETFLIX.COM Bal:NGN10,000.00\nOct 29, 2026 at 8:30 AM\nGTBank: Acct:012***890 Amt:NGN150,000.00 CR Desc:SALARY ACME Bal:NGN160,000.00",
  "exp": [
   {
    "amount": 4500,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "02:14"
   },
   {
    "amount": 150000,
    "direction": "credit",
    "date": "2026-10-29",
    "time": "08:30"
   }
  ]
 },
 {
  "label": "Long reference number must not become amount",
  "text": "Debit Alert Amt:NGN2,500.00 Des:NIP/TRF TO ADA Ref:000013261029140533123456 Date:29-Oct-2026 Bal:NGN500.00",
  "exp": [
   {
    "amount": 2500,
    "direction": "debit",
    "date": "2026-10-29"
   }
  ]
 },
 {
  "label": "Kobo amounts",
  "text": "Debit Alert Amt:NGN53.75 Des:VAT ON SMS Date:29-Oct-2026 Bal:NGN500.00",
  "exp": [
   {
    "amount": 53.75,
    "direction": "debit",
    "date": "2026-10-29"
   }
  ]
 },
 {
  "label": "Lowercase and ALL CAPS",
  "text": "DEBIT ALERT: YOUR ACCOUNT 012***890 HAS BEEN DEBITED WITH NGN 7,500.00 ON 29-OCT-2026. BAL: NGN 2,500.00",
  "exp": [
   {
    "amount": 7500,
    "direction": "debit",
    "date": "2026-10-29",
    "balance": 2500
   }
  ]
 },
 {
  "label": "Opay POS withdrawal slip",
  "text": "OPay Alert: POS Withdrawal\nAmount: ₦20,000.00\nFee: ₦100.00\nTime: 2026-10-29 17:20:09",
  "exp": [
   {
    "amount": 20000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "17:20",
    "desc": "POS Withdrawal"
   },
   {
    "amount": 100,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "Bank charge"
   }
  ]
 },
 {
  "label": "Plain line with amount then balance",
  "text": "2026-10-29 FOODCO ABUJA -N3,200.00 N12,000.00",
  "exp": [
   {
    "amount": 3200,
    "direction": "debit",
    "date": "2026-10-29",
    "balance": 12000
   }
  ]
 },
 {
  "label": "Hand typed commas, unquoted thousands",
  "opts": { "defaultCurrency": "NGN" },
  "text": "29 Oct 2026, Netflix, -4,500.00",
  "exp": [
   {
    "amount": 4500,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "Netflix"
   }
  ]
 },
 {
  "label": "Opay Reversal credit",
  "text": "Reversal: ₦5,000.00 has been returned to your OPay balance. 2026-10-29 14:30:00",
  "exp": [
   {
    "amount": 5000,
    "direction": "credit",
    "date": "2026-10-29"
   }
  ]
 },
 {
  "label": "Access email-ish with Narration",
  "text": "Dear Customer,\nYour account 012****789 has been debited.\nAmount: NGN 18,000.00\nNarration: NIP/TRF TO LANDLORD\nDate: 29 October 2026\nBalance: NGN 52,000.00\nThank you for banking with us.",
  "exp": [
   {
    "amount": 18000,
    "direction": "debit",
    "date": "2026-10-29",
    "balance": 52000
   }
  ]
 },
 {
  "label": "GTBank statement csv",
  "text": "Trans. Date,Value. Date,Reference,Debits,Credits,Balance,Originating Branch,Remarks\n05/10/2026,05/10/2026,000123,\"5,000.00\",,\"95,000.00\",HEAD OFFICE,NIP/TRF TO BOLA ADE\n06/10/2026,06/10/2026,000124,,\"150,000.00\",\"245,000.00\",HEAD OFFICE,SALARY OCT DANGOTE\n07/10/2026,07/10/2026,000125,\"10.75\",,\"244,989.25\",HEAD OFFICE,SMS ALERT CHARGE",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-05",
    "balance": 95000,
    "desc": "BOLA"
   },
   {
    "amount": 150000,
    "direction": "credit",
    "date": "2026-10-06"
   },
   {
    "amount": 10.75,
    "direction": "debit",
    "date": "2026-10-07"
   }
  ]
 },
 {
  "label": "Access csv with Posted Date",
  "text": "Posted Date,Value Date,Description,Debit,Credit,Balance\n2026-10-05,2026-10-05,POS/WEB PMT NETFLIX.COM,\"4,500.00\",,\"20,000.00\"\n2026-10-06,2026-10-06,SALARY OCT,,\"250,000.00\",\"270,000.00\"",
  "exp": [
   {
    "amount": 4500,
    "direction": "debit",
    "date": "2026-10-05",
    "desc": "NETFLIX"
   },
   {
    "amount": 250000,
    "direction": "credit",
    "date": "2026-10-06"
   }
  ]
 },
 {
  "label": "Zenith narration csv with N symbols",
  "text": "Date,Narration,Debit,Credit,Balance\n05-Oct-2026,ATM WDL ABUJA,₦20000.00,,₦80000.00\n06-Oct-2026,TRF FROM CHIDI,,₦5000.00,₦85000.00",
  "exp": [
   {
    "amount": 20000,
    "direction": "debit",
    "date": "2026-10-05"
   },
   {
    "amount": 5000,
    "direction": "credit",
    "date": "2026-10-06"
   }
  ]
 },
 {
  "label": "UBA with DR/CR column",
  "text": "Trans Date,Value Date,Narration,Amount,DR/CR,Balance\n05/10/2026,05/10/2026,USSD TRF TO KEMI,\"5,000.00\",DR,\"15,000.00\"\n06/10/2026,06/10/2026,SALARY,\"90,000.00\",CR,\"105,000.00\"",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-05"
   },
   {
    "amount": 90000,
    "direction": "credit",
    "date": "2026-10-06"
   }
  ]
 },
 {
  "label": "Opay statement",
  "text": "Trans. Time,Value Date,Description,Debit(₦),Credit(₦),Balance(₦),Channel,Transaction Reference\n2026-10-05 14:05:33,2026-10-05,Transfer to CHIOMA OKAFOR,\"5,000.00\",--,\"15,000.00\",Mobile,2026100514053312345\n2026-10-06 09:00:10,2026-10-06,Transfer from ACME LTD,--,\"90,000.00\",\"105,000.00\",Mobile,2026100609001012345",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-05",
    "time": "14:05",
    "desc": "CHIOMA"
   },
   {
    "amount": 90000,
    "direction": "credit",
    "date": "2026-10-06",
    "time": "09:00"
   }
  ]
 },
 {
  "label": "Kuda statement",
  "text": "Date/Time,Money In,Money Out,Category,To / From,Description,Balance\n05/10/2026 22:14:10,,\"₦2,000.00\",Food,CHICKEN REPUBLIC,POS purchase,\"₦8,000.00\"\n06/10/2026 09:30:00,\"₦50,000.00\",,Income,ACME LTD,Salary,\"₦58,000.00\"",
  "exp": [
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-05",
    "time": "22:14"
   },
   {
    "amount": 50000,
    "direction": "credit",
    "date": "2026-10-06",
    "time": "09:30"
   }
  ]
 },
 {
  "label": "Moniepoint statement",
  "text": "Date,Narration,Reference,Debit,Credit,Balance\n05/10/2026 18:45,POS PURCHASE BUKKA HUT,REF1,2000.00,,3100.00\n06/10/2026 08:00,TRANSFER FROM SAMUEL,REF2,,20000.00,23100.00",
  "exp": [
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-05",
    "time": "18:45"
   },
   {
    "amount": 20000,
    "direction": "credit",
    "date": "2026-10-06",
    "time": "08:00"
   }
  ]
 },
 {
  "label": "Semicolon csv, signed amounts, dd.mm.yyyy",
  "opts": { "defaultCurrency": "NGN" },
  "text": "Date;Description;Amount\n05.10.2026;NETFLIX;-4500,00\n06.10.2026;SALARY;250000,00",
  "exp": [
   {
    "amount": 4500,
    "direction": "debit",
    "date": "2026-10-05"
   },
   {
    "amount": 250000,
    "direction": "credit",
    "date": "2026-10-06"
   }
  ]
 },
 {
  "label": "csv with title lines above the header",
  "text": "GTBank Account Statement\nAccount Name: TUNDE FAKE\nPeriod: 01/10/2026 to 31/10/2026\n\nTrans. Date,Value Date,Reference,Debits,Credits,Balance,Remarks\n05/10/2026,05/10/2026,1,\"5,000.00\",,\"95,000.00\",TRF TO BOLA\nClosing Balance,,,,,\"95,000.00\",",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-05"
   }
  ]
 },
 {
  "label": "HTML table email, quoted-printable",
  "text": "From: GTBank <noreply@gtbank.example>\nSubject: GTBank Transaction Alert\nDate: Thu, 29 Oct 2026 02:14:00 +0100\nMIME-Version: 1.0\nContent-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n<html><body><p>Dear TUNDE,</p><table><tr><td>Description</td><td>POS/W=\nEB PMT NETFLIX.COM</td></tr><tr><td>Amount</td><td>=E2=82=A64,500.00 D=\nR</td></tr><tr><td>Value Date</td><td>29/10/2026</td></tr><tr><td>Time=\n of Transaction</td><td>02:14 AM</td></tr><tr><td>Current Balance</td>=\n<td>=E2=82=A610,000.00</td></tr></table></body></html>",
  "exp": [
   {
    "amount": 4500,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "02:14",
    "desc": "NETFLIX",
    "balance": 10000
   }
  ]
 },
 {
  "label": "Email with only Date header, no date in body",
  "text": "From: Access <alert@accessbank.example>\nSubject: Debit Alert\nDate: Thu, 29 Oct 2026 14:05:00 +0100\n\nAmt:NGN5,000.00\nDes:NIP/TRF TO BOLA ADE\nBal:NGN11,000.00",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "14:05",
    "desc": "BOLA"
   }
  ]
 },
 {
  "label": "NBSP and odd spacing",
  "text": "Debit Alert Amt: NGN 5,000.00 Des:POS/MAMA PUT Date:29-Oct-2026 Bal:NGN 1,000.00",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "MAMA"
   }
  ]
 },
 {
  "label": "Two digit year, dd/mm/yy",
  "text": "Credit Alert Amt:NGN12,000.00 Des:TRF FROM MUM Date:28/10/26 Bal:NGN30,000.00",
  "exp": [
   {
    "amount": 12000,
    "direction": "credit",
    "date": "2026-10-28",
    "desc": "MUM"
   }
  ]
 },
 {
  "label": "Reversed day order mm/dd",
  "text": "Debit Alert Amt:NGN2,000.00 Des:POS Date:10/29/2026 Bal:NGN1,000.00",
  "exp": [
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-29"
   }
  ]
 },
 {
  "label": "Account number contains many digits",
  "text": "Debit Alert: A/c 0123456789 debited NGN 3,000.00 on 29-Oct-2026 Desc: POS/CAFE Bal NGN 9,000.00",
  "exp": [
   {
    "amount": 3000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "CAFE"
   }
  ]
 },
 {
  "label": "Duplicate alert pasted twice is removed",
  "text": "Debit Alert Amt:NGN2,000.00 Des:POS/CAFE Date:29-Oct-2026 Bal:NGN1,000.00\n\nDebit Alert Amt:NGN2,000.00 Des:POS/CAFE Date:29-Oct-2026 Bal:NGN1,000.00",
  "exp": [
   {
    "amount": 2000,
    "date": "2026-10-29"
   }
  ]
 },
 {
  "label": "Amount with CR suffix and Narration after",
  "text": "Amt: NGN 200,000.00 CR Narration: SALARY OCT Date: 28-Oct-2026 Bal: NGN 210,000.00",
  "exp": [
   {
    "amount": 200000,
    "direction": "credit",
    "date": "2026-10-28",
    "balance": 210000,
    "desc": "SALARY"
   }
  ]
 },
 {
  "label": "Wema ALAT date after balance",
  "text": "ALAT: Your account has been debited with ₦3,500.00. Description: Bolt ride. Balance: ₦12,300.00. 29/10/2026 20:11",
  "exp": [
   {
    "amount": 3500,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "20:11",
    "balance": 12300,
    "desc": "Bolt"
   }
  ]
 },
 {
  "label": "Sterling colon-less Date and Bal",
  "text": "Sterling Alert: Acct 0012***34 DR NGN6,000.00 Narr: WEB/JUMIA Date 29/10/2026 08:45 Bal NGN 100.00",
  "exp": [
   {
    "amount": 6000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "08:45",
    "balance": 100,
    "desc": "JUMIA"
   }
  ]
 },
 {
  "label": "Alert! prefix with colon-less Bal",
  "text": "Alert! Debit of NGN 2,500 on your account 012***890. Desc: GLO DATA 29-OCT-26 Bal NGN 400",
  "exp": [
   {
    "amount": 2500,
    "direction": "debit",
    "date": "2026-10-29",
    "balance": 400,
    "desc": "GLO DATA"
   }
  ]
 },
 {
  "label": "Opay betting free text",
  "text": "Transaction Notification: Debit ₦2,000.00 BETTING DEPOSIT - SPORTYBET 2026-10-29 02:45:10 Balance ₦500.00",
  "exp": [
   {
    "amount": 2000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "02:45",
    "balance": 500,
    "desc": "SPORTYBET"
   }
  ]
 },
 {
  "label": "Kuda fee sentence keeps the word charge",
  "text": "Kuda: A fee of ₦10.75 was charged on 29 Oct 2026 for NIP transfer. Balance ₦6,000.00",
  "exp": [
   {
    "amount": 10.75,
    "direction": "debit",
    "date": "2026-10-29",
    "balance": 6000,
    "desc": "charge"
   }
  ]
 },
 {
  "label": "Alert with its own Fee line becomes two items",
  "text": "Debit Alert\nAmt: NGN 5,000.00\nVAT: NGN 0.75\nDes: NIP TRF\nDate: 29-Oct-2026",
  "exp": [
   {
    "amount": 5000,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "NIP TRF"
   },
   {
    "amount": 0.75,
    "direction": "debit",
    "date": "2026-10-29",
    "desc": "Bank charge"
   }
  ]
 },
 {
  "label": "First Bank sentence with at time",
  "text": "FirstBank: Debit of NGN 4,000.00 on 29-OCT-2026 at 09:15. Narr: POS/TRANSFER. Avail Bal: NGN 6,000.00",
  "exp": [
   {
    "amount": 4000,
    "direction": "debit",
    "date": "2026-10-29",
    "time": "09:15",
    "balance": 6000,
    "desc": "POS"
   }
  ]
 }
];


function check(c) {
  // Cases with no marker and no Nigerian hint at all pass defaultCurrency (global rule: unmarked amounts default to USD).
  const r = parseInput(c.text, c.opts);
  const got = r.items;
  assert.equal(got.length, c.exp.length, c.label + ': expected ' + c.exp.length + ' items, got ' + got.length + ' ' + JSON.stringify(r.warnings));
  c.exp.forEach((e, i) => {
    const g = got[i];
    for (const k of ['amount', 'direction', 'date', 'time', 'balance']) {
      if (e[k] !== undefined) assert.equal(g[k], e[k], c.label + ' item ' + i + ' ' + k);
    }
    if (e.desc) assert.match(g.description, new RegExp(e.desc, 'i'), c.label + ' item ' + i + ' description');
    assert.equal(g.currency, 'NGN');
    assert.ok(g.amount > 0);
  });
}

for (const c of CASES) test('nigerian formats: ' + c.label, () => check(c));

test('nigerian formats: an alert with no debit or credit marker is refused with a warning, not guessed', () => {
  const r = parseInput('Acct:012***890 Amt:NGN1,500.00 Desc:POS/CHOP LIFE Date:29-Oct-2026 Bal:NGN8,500.00');
  assert.equal(r.items.length, 0);
  assert.ok(r.warnings.some((w) => /debit from credit/.test(w)));
});

test('nigerian formats: three alerts pasted with no blank lines and no header words all survive', () => {
  const r = parseInput([
    'GTBank: Acct:012***890 Amt:NGN1,000.00 DR Desc:POS/BOLT Date:27-Oct-2026 Bal:NGN9,000.00',
    'GTBank: Acct:012***890 Amt:NGN2,000.00 DR Desc:POS/BOLT Date:28-Oct-2026 Bal:NGN7,000.00',
    'GTBank: Acct:012***890 Amt:NGN3,000.00 DR Desc:POS/BOLT Date:29-Oct-2026 Bal:NGN4,000.00',
  ].join('\n'));
  assert.deepEqual(r.items.map((i) => i.amount), [1000, 2000, 3000]);
});

test('nigerian formats: unquoted thousands commas never turn 4,500 into 500', () => {
  for (const t of ['29 Oct 2026, Netflix, -4,500.00', '2026-10-29, NETFLIX, -4,500.00', '2026-10-29 NETFLIX -4,500.00']) {
    const r = parseInput(t);
    assert.equal(r.items.length, 1, t);
    assert.equal(r.items[0].amount, 4500, t);
    assert.equal(r.items[0].direction, 'debit', t);
  }
});

test('nigerian formats: night time alerts keep their time so the night ghost can see them', () => {
  const r = parseInput('Transaction Alert [Debit]\nDescription: POS/WEB PMT SPORTYBET\nAmount: NGN 2,000.00\nValue Date: 29/10/2026\nTime of Transaction: 03:41 AM');
  assert.equal(r.items[0].time, '03:41');
});

test('nigerian formats: nothing here throws on odd mixes', () => {
  const junk = ['\u20a6\u20a6\u20a6', 'Debit Alert', 'NGN', 'Amt: Amt: Amt:', '|||', 'Date: 99/99/9999 Amt: NGN 1', 'Debit Alert Amt:NGN\n'.repeat(50)];
  for (const j of junk) {
    const r = parseInput(j);
    assert.ok(Array.isArray(r.items) && Array.isArray(r.warnings));
  }
});
